/**
 * Sandboxed Cloud Repository File Store (`GitRepoStore`) in `octocloud`.
 * Turns a GitHub repository into a serverless cloud file & JSON database for static web apps.
 * Enforces path sanitization (blocks `..` traversal) and repository write sandboxing.
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

/**
 * Sanitize a relative repository file path and reject any `..` traversal attempts.
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

export class GitRepoStore {
  private shaCache: Map<string, string> = new Map();
  private contentCache: Map<string, string> = new Map();

  constructor(public readonly auth: GitCloudAuth) {}

  /** Clear cached file contents and SHAs. */
  public clearCache(): void {
    this.shaCache.clear();
    this.contentCache.clear();
  }

  /** Check whether a filename matches the configured `extensions` filter (if any). */
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
   * Ensure the active repository exists. If missing and `autoCreateRepo` is enabled
   * (with write access), creates the repository automatically as a public workspace repo.
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

  /** Create a new public GitHub repository under the authenticated user's account. */
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
   * List files in the repository directory (filtered by `options.extensions` if configured).
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
   * Read a UTF-8 text file from the user's repository (or another user's public repository when `ownerOverride` is given).
   */
  public async readFile(filePath: string, ownerOverride?: string, repoOverride?: string): Promise<string> {
    const owner = ownerOverride || this.auth.username;
    const repo = repoOverride || this.auth.repo;
    const cleanPath = sanitizeRepoPath(filePath);
    const cacheKey = `${owner}/${repo}/${cleanPath}`;

    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${cleanPath}`;
    const res = await this.auth.options.fetchImpl(url, {
      headers: this.auth.getHeaders(),
    });

    if (!res.ok) {
      throw new Error(`Failed to read file "${cleanPath}" from ${owner}/${repo} (HTTP ${res.status})`);
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
   * Fetch all matching files and their decoded contents from the repository directory.
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
   * Create or update a file in the authenticated user's sandboxed workspace repository.
   * Automatically resolves the existing file blob `sha` if updating an existing file.
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
    const res = await this.auth.options.fetchImpl(putUrl, {
      method: 'PUT',
      headers: this.auth.getHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });

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
   * Delete a file from the authenticated user's sandboxed workspace repository.
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

  /** Convenience helper to read and parse a JSON file from a repository. */
  public async readJSON<T = unknown>(filePath: string, ownerOverride?: string, repoOverride?: string): Promise<T> {
    const raw = await this.readFile(filePath, ownerOverride, repoOverride);
    return JSON.parse(raw) as T;
  }

  /** Convenience helper to serialize and write a JSON object to the authenticated user's repository. */
  public async writeJSON<T = unknown>(
    filePath: string,
    data: T,
    commitMessage?: string
  ): Promise<{ path: string; sha: string }> {
    const formatted = JSON.stringify(data, null, 2);
    return this.writeFile(filePath, formatted, commitMessage);
  }
}
