/**
 * Optimistic write queue and cross-tab sync (`GitSyncQueue`).
 *
 * Buffers file writes and deletes locally, coalesces repeated updates to the same path,
 * broadcasts queue mutations across same-origin tabs via `BroadcastChannel`, and flushes
 * pending changes in a single commit via `store.commitBatch()`.
 */
import { GitRepoStore, sanitizeRepoPath, BatchFileChange, BatchCommitResult } from './store';

export interface QueuedOperation {
  path: string;
  /** UTF-8 content for write, or `null` for delete */
  content: string | null;
  queuedAt: number;
}

export interface SyncQueueOptions {
  /** `localStorage` key for persisting un-flushed operations (default: `'octocloud_sync_queue'`) */
  storageKey?: string | false;
  /** `BroadcastChannel` name for cross-tab notifications (default: `'octocloud_sync_channel'`) */
  channelName?: string | false;
  /** Optional debounce interval in ms for automatic flushing (`0` disables auto-flush) */
  autoFlushDebounceMs?: number;
  /** Target branch passed to `store.commitBatch()` (default: `'main'`) */
  branch?: string;
}

export type SyncQueueListener = (pending: QueuedOperation[]) => void;

export class GitSyncQueue {
  public readonly options: Required<SyncQueueOptions>;
  private pendingOps: Map<string, QueuedOperation> = new Map();
  private listeners: Set<SyncQueueListener> = new Set();
  private channel: BroadcastChannel | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private isFlushing = false;

  constructor(
    public readonly store: GitRepoStore,
    options: SyncQueueOptions = {}
  ) {
    this.options = {
      storageKey: options.storageKey === undefined ? 'octocloud_sync_queue' : options.storageKey,
      channelName: options.channelName === undefined ? 'octocloud_sync_channel' : options.channelName,
      autoFlushDebounceMs: options.autoFlushDebounceMs ?? 0,
      branch: options.branch ?? 'main',
    };

    this.restoreFromStorage();
    this.initBroadcastChannel();
  }

  /** Number of coalesced file operations currently pending flush. */
  public get pendingCount(): number {
    return this.pendingOps.size;
  }

  /** Pending operations ordered by `queuedAt`. */
  public getPendingOperations(): QueuedOperation[] {
    return Array.from(this.pendingOps.values()).sort((a, b) => a.queuedAt - b.queuedAt);
  }

  /** Subscribe to queue state updates. */
  public onQueueChange(listener: SyncQueueListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners(): void {
    const snapshot = this.getPendingOperations();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private initBroadcastChannel(): void {
    if (!this.options.channelName || typeof BroadcastChannel === 'undefined') {
      return;
    }
    try {
      this.channel = new BroadcastChannel(this.options.channelName);
      this.channel.onmessage = (event) => {
        const data = event?.data;
        if (!data || typeof data !== 'object') return;
        if (data.type === 'ENQUEUE' && data.op && typeof data.op.path === 'string') {
          this.pendingOps.set(data.op.path, data.op as QueuedOperation);
          this.notifyListeners();
        } else if (data.type === 'FLUSHED' && Array.isArray(data.paths)) {
          for (const p of data.paths) {
            this.pendingOps.delete(p);
          }
          this.notifyListeners();
        }
      };
    } catch {
      this.channel = null;
    }
  }

  private persistToStorage(): void {
    if (!this.options.storageKey || typeof localStorage === 'undefined') {
      return;
    }
    try {
      const payload = JSON.stringify(this.getPendingOperations());
      localStorage.setItem(this.options.storageKey, payload);
    } catch {
      // Ignore storage quota errors
    }
  }

  private restoreFromStorage(): void {
    if (!this.options.storageKey || typeof localStorage === 'undefined') {
      return;
    }
    try {
      const raw = localStorage.getItem(this.options.storageKey);
      if (!raw) return;
      const list = JSON.parse(raw) as QueuedOperation[];
      if (Array.isArray(list)) {
        for (const op of list) {
          if (op && typeof op.path === 'string') {
            this.pendingOps.set(op.path, op);
          }
        }
      }
    } catch {
      // Ignore malformed storage entries
    }
  }

  private scheduleAutoFlush(): void {
    if (this.options.autoFlushDebounceMs <= 0) return;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch(() => {});
    }, this.options.autoFlushDebounceMs);
  }

  /**
   * Enqueue a UTF-8 file write, replacing any prior un-flushed operation for `filePath`.
   */
  public enqueueWrite(filePath: string, content: string): QueuedOperation {
    const cleanPath = sanitizeRepoPath(filePath);
    const op: QueuedOperation = {
      path: cleanPath,
      content,
      queuedAt: Date.now(),
    };
    this.pendingOps.set(cleanPath, op);
    this.persistToStorage();
    this.channel?.postMessage({ type: 'ENQUEUE', op });
    this.notifyListeners();
    this.scheduleAutoFlush();
    return op;
  }

  /**
   * Enqueue a JSON file write.
   */
  public enqueueJSON<T = unknown>(filePath: string, data: T): QueuedOperation {
    return this.enqueueWrite(filePath, JSON.stringify(data, null, 2));
  }

  /**
   * Enqueue a file deletion.
   */
  public enqueueDelete(filePath: string): QueuedOperation {
    const cleanPath = sanitizeRepoPath(filePath);
    const op: QueuedOperation = {
      path: cleanPath,
      content: null,
      queuedAt: Date.now(),
    };
    this.pendingOps.set(cleanPath, op);
    this.persistToStorage();
    this.channel?.postMessage({ type: 'ENQUEUE', op });
    this.notifyListeners();
    this.scheduleAutoFlush();
    return op;
  }

  /**
   * Read a file through the local queue overlay before falling back to `store.readFile()`.
   */
  public async readOptimistic(filePath: string): Promise<string> {
    const cleanPath = sanitizeRepoPath(filePath);
    if (this.pendingOps.has(cleanPath)) {
      const pending = this.pendingOps.get(cleanPath)!;
      if (pending.content === null) {
        throw new Error(`File "${cleanPath}" is marked for deletion in GitSyncQueue`);
      }
      return pending.content;
    }
    return this.store.readFile(cleanPath);
  }

  /**
   * Read and parse a JSON file through the local queue overlay.
   */
  public async readOptimisticJSON<T = unknown>(filePath: string): Promise<T> {
    const raw = await this.readOptimistic(filePath);
    return JSON.parse(raw) as T;
  }

}
