/**
 * Repository file store (`GitRepoStore`).
 *
 * Wraps the GitHub Contents API, Git Data Trees API, and raw content CDN
 * behind path normalization and repository write sandboxing.
 */
import { GitCloudAuth } from './auth';
import { encodeBase64UTF8, decodeBase64UTF8 } from './base64';

export interface RepoFileEntry {
  name: string;
  path: string;
  sha: string;
  size: number;
  url: string;
  downloadUrl?: string;
}

export interface LoadedRepoFile extends RepoFileEntry {
  content: string;
}

export type PublicReadStrategy = 'cdn-first' | 'api';

export interface ReadPublicFileOptions {
  owner?: string;
  repo?: string;
  branch?: string;
  strategy?: PublicReadStrategy;
}

/**
 * Normalize a relative repository path and reject `.` or `..` traversal segments.
 */
export function sanitizeRepoPath(filePath: string): string {
  const cleaned = filePath.trim().replace(/^\/+|\/+$/g, '');
  if (!cleaned) {
    throw new Error('File path cannot be empty');
  }
  const segments = cleaned.split('/');
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..') {
      throw new Error(`Invalid or unsafe repository file path "${filePath}"`);
    }
  }
  return cleaned;
}

export interface PullRequestProposalResult {
  prNumber: number;
  prUrl: string;
  forkOwner: string;
  branch: string;
  path: string;
  sha: string;
}

export interface BatchFileChange {
  path: string;
  /** UTF-8 file content, or `null` to remove the path from the Git tree */
  content: string | null;
}

export interface BatchCommitResult {
  commitSha: string;
  treeSha: string;
  branch: string;
  fileCount: number;
}

export class GitRepoStore {
  private shaCache: Map<string, string> = new Map();
  private contentCache: Map<string, string> = new Map();
  private etagCache: Map<string, string> = new Map();

  constructor(public readonly auth: GitCloudAuth) {}

  /** Clear cached file contents, ETags, and blob SHAs. */
  public clearCache(): void {
    this.shaCache.clear();
    this.contentCache.clear();
    this.etagCache.clear();
  }

  /** Check whether `filename` matches the configured extension filter. */
  public matchesExtension(filename: string): boolean {
    const exts = this.auth.options.extensions;
    if (!exts || exts.length === 0) {
      return true;
    }
    const lower = filename.toLowerCase();
    return exts.some((ext) => {
      const normalizedExt = ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
      return lower.endsWith(normalizedExt);
    });
  }

  /**
   * Check whether the active repository exists, creating it if `autoCreateRepo`
   * is enabled and the session has write permissions.
   */
  public async ensureRepo(): Promise<boolean> {
    if (!this.auth.username || !this.auth.repo) {
      throw new Error('User must be logged in before accessing repository storage');
    }

    const checkUrl = `https://api.github.com/repos/${this.auth.username}/${this.auth.repo}`;
    const res = await this.auth.options.fetchImpl(checkUrl, {
      headers: this.auth.getHeaders(),
    });

    if (res.status === 200) {
      return true;
    }

    if (res.status === 404 && this.auth.options.autoCreateRepo && this.auth.hasWriteAccess()) {
      await this.createRepo(this.auth.repo);
      return true;
    }

    return false;
  }

  /** Create a public repository under the authenticated user's account. */
  public async createRepo(repoName = this.auth.repo): Promise<void> {
    this.auth.setRepo(repoName);
    this.auth.assertWriteAllowed(this.auth.repo);

    const res = await this.auth.options.fetchImpl('https://api.github.com/user/repos', {
      method: 'POST',
      headers: this.auth.getHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        name: this.auth.repo,
        private: false,
        auto_init: true,
      }),
    });

    if (!res.ok) {
      throw new Error(`Failed to create repository "${this.auth.repo}" (HTTP ${res.status})`);
    }
  }

  /**
   * List files in a repository directory, filtered by `options.extensions` when set.
   */
  public async listFiles(dirPath = '', ownerOverride?: string, repoOverride?: string): Promise<RepoFileEntry[]> {
    const owner = ownerOverride || this.auth.username;
    const repo = repoOverride || this.auth.repo;
    if (!owner || !repo) {
      throw new Error('Not authenticated');
    }

    const cleanDir = dirPath.trim() ? sanitizeRepoPath(dirPath) : '';
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${cleanDir}`;
    const res = await this.auth.options.fetchImpl(url, {
      headers: this.auth.getHeaders(),
    });

    if (res.status === 404) {
      if (
        owner === this.auth.username &&
        repo === this.auth.repo &&
        this.auth.options.autoCreateRepo &&
        this.auth.hasWriteAccess() &&
        cleanDir === ''
      ) {
        await this.createRepo(this.auth.repo);
        return [];
      }
      throw new Error(`Repository or path "${owner}/${repo}/${cleanDir}" not found`);
    }

    if (!res.ok) {
      throw new Error(`Failed to list repository contents (HTTP ${res.status})`);
    }

    const items = await res.json();
    if (!Array.isArray(items)) {
      return [];
    }

    const files: RepoFileEntry[] = [];
    for (const item of items) {
      if (item.type === 'file' && this.matchesExtension(item.name)) {
        this.shaCache.set(`${owner}/${repo}/${item.path}`, item.sha);
        files.push({
          name: item.name,
          path: item.path,
          sha: item.sha,
          size: item.size ?? 0,
          url: item.url,
          downloadUrl: item.download_url,
        });
      }
    }
    return files;
  }

  /**
   * Read a UTF-8 file from the repository via the Contents API.
   * Uses `If-None-Match` when a cached `ETag` is available.
   */
  public async readFile(filePath: string, ownerOverride?: string, repoOverride?: string): Promise<string> {
    const owner = ownerOverride || this.auth.username;
    const repo = repoOverride || this.auth.repo;
    const cleanPath = sanitizeRepoPath(filePath);
    const cacheKey = `${owner}/${repo}/${cleanPath}`;

    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${cleanPath}`;
    const reqHeaders: Record<string, string> = {};
    const prevEtag = this.etagCache.get(cacheKey);
    if (prevEtag && this.contentCache.has(cacheKey)) {
      reqHeaders['If-None-Match'] = prevEtag;
    }

    const res = await this.auth.options.fetchImpl(url, {
      headers: this.auth.getHeaders(reqHeaders),
    });

    if (res.status === 304 && this.contentCache.has(cacheKey)) {
      return this.contentCache.get(cacheKey)!;
    }

    if (!res.ok) {
      throw new Error(`Failed to read file "${cleanPath}" from ${owner}/${repo} (HTTP ${res.status})`);
    }

    const etag = res.headers?.get?.('ETag') || res.headers?.get?.('etag');
    if (etag) {
      this.etagCache.set(cacheKey, etag);
    }

    const data = await res.json();
    if (data.sha) {
      this.shaCache.set(cacheKey, data.sha);
    }
    const decoded = decodeBase64UTF8(data.content || '');
    this.contentCache.set(cacheKey, decoded);
    return decoded;
  }

  /**
   * Read a public file from `raw.githubusercontent.com` first, falling back to
   * the REST Contents API if the raw fetch fails.
   */
  public async readPublicFile(filePath: string, options: ReadPublicFileOptions = {}): Promise<string> {
    const owner = options.owner || this.auth.username;
    const repo = options.repo || this.auth.repo;
    const branch = options.branch || 'main';
    const strategy = options.strategy || 'cdn-first';
    if (!owner || !repo) {
      throw new Error('Owner and repository name are required for readPublicFile()');
    }

    const cleanPath = sanitizeRepoPath(filePath);
    const cacheKey = `${owner}/${repo}/${cleanPath}`;

    if (strategy === 'cdn-first') {
      const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${cleanPath}`;
      try {
        const rawRes = await this.auth.options.fetchImpl(rawUrl);
        if (rawRes.ok) {
          const text = await rawRes.text();
          this.contentCache.set(cacheKey, text);
          return text;
        }
      } catch {
        // Fall through to Contents API
      }
    }

    return this.readFile(cleanPath, owner, repo);
  }

  /**
   * Read and parse a public JSON file via `readPublicFile`.
   */
  public async readPublicJSON<T = unknown>(filePath: string, options: ReadPublicFileOptions = {}): Promise<T> {
    const raw = await this.readPublicFile(filePath, options);
    return JSON.parse(raw) as T;
  }

  /**
   * Read all matching files in `dirPath` and return a `Map<filename, content>`.
   */
  public async fetchAllFiles(dirPath = ''): Promise<Map<string, string>> {
    const entries = await this.listFiles(dirPath);
    const result = new Map<string, string>();
    for (const entry of entries) {
      const content = await this.readFile(entry.path);
      result.set(entry.name, content);
    }
    return result;
  }

  /**
   * Create or update a file in the active workspace repository.
   * Resolves the existing blob SHA automatically and retries once on HTTP 409/422.
   */
  public async writeFile(
    filePath: string,
    content: string,
    commitMessage?: string
  ): Promise<{ path: string; sha: string }> {
    this.auth.assertWriteAllowed(this.auth.repo);

    const cleanPath = sanitizeRepoPath(filePath);
    const cacheKey = `${this.auth.username}/${this.auth.repo}/${cleanPath}`;
    let sha = this.shaCache.get(cacheKey);

    if (!sha) {
      const checkUrl = `https://api.github.com/repos/${this.auth.username}/${this.auth.repo}/contents/${cleanPath}`;
      const checkRes = await this.auth.options.fetchImpl(checkUrl, {
        headers: this.auth.getHeaders(),
      });
      if (checkRes.status === 200) {
        const existing = await checkRes.json();
        if (existing.sha) {
          sha = existing.sha;
        }
      }
    }

    const payload: Record<string, string> = {
      message: commitMessage || `Save ${cleanPath}`,
      content: encodeBase64UTF8(content),
    };
    if (sha) {
      payload.sha = sha;
    }

    const putUrl = `https://api.github.com/repos/${this.auth.username}/${this.auth.repo}/contents/${cleanPath}`;
    let res = await this.auth.options.fetchImpl(putUrl, {
      method: 'PUT',
      headers: this.auth.getHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });

    if (res.status === 409 || res.status === 422) {
      const refreshRes = await this.auth.options.fetchImpl(putUrl, {
        headers: this.auth.getHeaders(),
      });
      if (refreshRes.status === 200) {
        const latest = await refreshRes.json();
        if (latest.sha) {
          payload.sha = latest.sha;
          this.shaCache.set(cacheKey, latest.sha);
          res = await this.auth.options.fetchImpl(putUrl, {
            method: 'PUT',
            headers: this.auth.getHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(payload),
          });
        }
      }
    }

    if (!res.ok) {
      throw new Error(`Failed to write file "${cleanPath}" (HTTP ${res.status})`);
    }

    const resData = await res.json();
    const newSha: string = resData?.content?.sha || sha || '';
    if (newSha) {
      this.shaCache.set(cacheKey, newSha);
    }
    this.contentCache.set(cacheKey, content);
    return { path: cleanPath, sha: newSha };
  }

  /**
   * Delete a file from the active workspace repository.
   */
  public async deleteFile(filePath: string, commitMessage?: string): Promise<void> {
    this.auth.assertWriteAllowed(this.auth.repo);

    const cleanPath = sanitizeRepoPath(filePath);
    const cacheKey = `${this.auth.username}/${this.auth.repo}/${cleanPath}`;
    let sha = this.shaCache.get(cacheKey);
    if (!sha) {
      await this.readFile(cleanPath);
      sha = this.shaCache.get(cacheKey);
    }
    if (!sha) {
      throw new Error(`Cannot delete "${cleanPath}": file SHA not found`);
    }

    const url = `https://api.github.com/repos/${this.auth.username}/${this.auth.repo}/contents/${cleanPath}`;
    const res = await this.auth.options.fetchImpl(url, {
      method: 'DELETE',
      headers: this.auth.getHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        message: commitMessage || `Delete ${cleanPath}`,
        sha,
      }),
    });

    if (!res.ok) {
      throw new Error(`Failed to delete file "${cleanPath}" (HTTP ${res.status})`);
    }

    this.shaCache.delete(cacheKey);
    this.contentCache.delete(cacheKey);
  }

  /** Read and parse a JSON file from a repository. */
  public async readJSON<T = unknown>(filePath: string, ownerOverride?: string, repoOverride?: string): Promise<T> {
    const raw = await this.readFile(filePath, ownerOverride, repoOverride);
    return JSON.parse(raw) as T;
  }

  /** Serialize and write a JSON value to the active workspace repository. */
  public async writeJSON<T = unknown>(
    filePath: string,
    data: T,
    commitMessage?: string
  ): Promise<{ path: string; sha: string }> {
    const formatted = JSON.stringify(data, null, 2);
    return this.writeFile(filePath, formatted, commitMessage);
  }

  /**
   * Fork an upstream repository, commit a file to a branch on the fork,
   * and open a pull request against `upstreamOwner/upstreamRepo`.
   */
  public async proposeFileChangeViaPR(options: {
    upstreamOwner: string;
    upstreamRepo: string;
    filePath: string;
    content: string;
    title: string;
    body?: string;
    baseBranch?: string;
    headBranch?: string;
  }): Promise<PullRequestProposalResult> {
    if (!this.auth.hasWriteAccess() || !this.auth.username) {
      throw new Error('Authenticated write session is required to propose a Pull Request');
    }

    const cleanPath = sanitizeRepoPath(options.filePath);
    const baseBranch = options.baseBranch || 'main';
    const headBranch = options.headBranch || `octocloud-patch-${Date.now()}`;
    const forkOwner = this.auth.username;

    const forkRes = await this.auth.options.fetchImpl(
      `https://api.github.com/repos/${options.upstreamOwner}/${options.upstreamRepo}/forks`,
      {
        method: 'POST',
        headers: this.auth.getHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({}),
      }
    );
    if (!forkRes.ok && forkRes.status !== 202 && forkRes.status !== 200) {
      throw new Error(`Failed to create fork for ${options.upstreamOwner}/${options.upstreamRepo} (HTTP ${forkRes.status})`);
    }

    const putUrl = `https://api.github.com/repos/${forkOwner}/${options.upstreamRepo}/contents/${cleanPath}`;
    const putRes = await this.auth.options.fetchImpl(putUrl, {
      method: 'PUT',
      headers: this.auth.getHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        message: options.title,
        content: encodeBase64UTF8(options.content),
        branch: headBranch,
      }),
    });

    if (!putRes.ok) {
      throw new Error(`Failed to write proposed file to fork ${forkOwner}/${options.upstreamRepo} (HTTP ${putRes.status})`);
    }
    const putData = await putRes.json();
    const newSha: string = putData?.content?.sha || '';

    const prRes = await this.auth.options.fetchImpl(
      `https://api.github.com/repos/${options.upstreamOwner}/${options.upstreamRepo}/pulls`,
      {
        method: 'POST',
        headers: this.auth.getHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          title: options.title,
          body: options.body || `Proposed via octocloud by @${forkOwner}`,
          head: `${forkOwner}:${headBranch}`,
          base: baseBranch,
        }),
      }
    );

    if (!prRes.ok) {
      throw new Error(`Failed to open Pull Request on ${options.upstreamOwner}/${options.upstreamRepo} (HTTP ${prRes.status})`);
    }
    const prData = await prRes.json();

    return {
      prNumber: prData.number ?? 1,
      prUrl: prData.html_url || '',
      forkOwner,
      branch: headBranch,
      path: cleanPath,
      sha: newSha,
    };
  }

}
