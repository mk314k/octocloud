/**
 * Federated pub/sub, peer presence, and WebRTC signaling channel (`GitChannel<Payload>`).
 *
 * Each participant writes messages and presence heartbeats to their own repository
 * at `channels/<channelName>/inbox.json` and polls peer inboxes across repositories.
 */
import { GitRepoStore, sanitizeRepoPath } from './store';
import { PlayerIdentity, GitPeerRoom } from './multiplayer';

export interface ChannelEnvelope<Payload = unknown> {
  id: string;
  channel: string;
  topic: string;
  sender: PlayerIdentity;
  recipient?: string;
  payload: Payload;
  timestamp: number;
}

export interface PeerPresenceState {
  player: PlayerIdentity;
  status: 'online' | 'idle' | 'offline';
  lastSeen: number;
  metadata?: Record<string, unknown>;
}

export interface ChannelInboxState<Payload = unknown> {
  channel: string;
  owner: string;
  presence: PeerPresenceState;
  messages: ChannelEnvelope<Payload>[];
  updatedAt: number;
}

export type ChannelMessageListener<Payload = unknown> = (envelope: ChannelEnvelope<Payload>) => void;
export type PresenceListener = (presenceList: PeerPresenceState[]) => void;

export interface GitChannelOptions {
  /** Maximum messages kept in a user's rolling inbox file (default: 50) */
  maxInboxMessages?: number;
  /** Milliseconds before a peer without a heartbeat is marked `'offline'` (default: 60_000) */
  presenceTtlMs?: number;
}

export class GitChannel<Payload = unknown> {
  public readonly channelName: string;
  public readonly options: Required<GitChannelOptions>;
  private seenMessageIds: Set<string> = new Set();
  private msgListeners: Set<ChannelMessageListener<Payload>> = new Set();
  private presenceListeners: Set<PresenceListener> = new Set();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private localMessages: ChannelEnvelope<Payload>[] = [];

  constructor(
    public readonly store: GitRepoStore,
    channelName = 'lobby',
    options: GitChannelOptions = {}
  ) {
    this.channelName = sanitizeRepoPath(channelName).replace(/\//g, '_');
    this.options = {
      maxInboxMessages: options.maxInboxMessages ?? 50,
      presenceTtlMs: options.presenceTtlMs ?? 60_000,
    };
  }

  private get inboxPath(): string {
    return `channels/${this.channelName}/inbox.json`;
  }

  private getLocalIdentity(): PlayerIdentity {
    const profile = this.store.auth.profile;
    return {
      username: profile?.username || 'guest',
      name: profile?.name || profile?.username || 'Guest',
      avatarUrl: profile?.avatarUrl,
      repo: this.store.auth.repo,
    };
  }

  /** Subscribe to incoming messages discovered during `pollPeers()`. */
  public onMessage(listener: ChannelMessageListener<Payload>): () => void {
    this.msgListeners.add(listener);
    return () => this.msgListeners.delete(listener);
  }

  /** Subscribe to peer presence snapshots updated during `pollPeers()`. */
  public onPresenceChange(listener: PresenceListener): () => void {
    this.presenceListeners.add(listener);
    return () => this.presenceListeners.delete(listener);
  }

  /**
   * Append a message to the local user's channel inbox and update their presence timestamp.
   */
  public async publish(
    topic: string,
    payload: Payload,
    options: {
      recipient?: string;
      status?: 'online' | 'idle';
      metadata?: Record<string, unknown>;
    } = {}
  ): Promise<ChannelEnvelope<Payload>> {
    const sender = this.getLocalIdentity();
    const now = Date.now();
    const id = `msg_${sender.username}_${now}_${Math.random().toString(36).slice(2, 8)}`;

    const envelope: ChannelEnvelope<Payload> = {
      id,
      channel: this.channelName,
      topic,
      sender,
      recipient: options.recipient,
      payload,
      timestamp: now,
    };

    this.seenMessageIds.add(id);
    this.localMessages.push(envelope);
    if (this.localMessages.length > this.options.maxInboxMessages) {
      this.localMessages = this.localMessages.slice(-this.options.maxInboxMessages);
    }

    const inboxState: ChannelInboxState<Payload> = {
      channel: this.channelName,
      owner: sender.username,
      presence: {
        player: sender,
        status: options.status ?? 'online',
        lastSeen: now,
        metadata: options.metadata,
      },
      messages: this.localMessages,
      updatedAt: now,
    };

    await this.store.writeJSON(
      this.inboxPath,
      inboxState,
      `Publish ${topic} message to channel ${this.channelName}`
    );

    return envelope;
  }

  /**
   * Update the local user's presence state without appending a message.
   */
  public async heartbeat(
    status: 'online' | 'idle' | 'offline' = 'online',
    metadata?: Record<string, unknown>
  ): Promise<PeerPresenceState> {
    const sender = this.getLocalIdentity();
    const now = Date.now();
    const presence: PeerPresenceState = {
      player: sender,
      status,
      lastSeen: now,
      metadata,
    };

    const inboxState: ChannelInboxState<Payload> = {
      channel: this.channelName,
      owner: sender.username,
      presence,
      messages: this.localMessages,
      updatedAt: now,
    };

    await this.store.writeJSON(
      this.inboxPath,
      inboxState,
      `Heartbeat (${status}) on channel ${this.channelName}`
    );
    return presence;
  }

}
