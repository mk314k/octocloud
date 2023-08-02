/**
 * Core GitHub Authentication module (`GitCloudAuth`) in `octocloud`.
 */

export type AuthMode = 'oauth' | 'pat' | 'readonly' | 'none';

export interface GitUserProfile {
  username: string;
  name?: string;
  avatarUrl?: string;
  profileUrl?: string;
  mode: AuthMode;
}

export interface GitAuthOptions {
  /** Default repository name used for cloud file storage */
  defaultRepo?: string;
  /** Allowed file extensions when listing/filtering repository files */
  extensions?: string[];
  /** Automatically create the target public repository on login if it does not exist */
  autoCreateRepo?: boolean;
  /** Optional custom fetch implementation (useful for testing or SSR) */
  fetchImpl?: typeof fetch;
}

export class GitCloudAuth {
  public readonly options: {
    defaultRepo: string;
    extensions: string[];
    autoCreateRepo: boolean;
    fetchImpl: typeof fetch;
  };

  private _profile: GitUserProfile | null = null;
  private _token: string = '';
  private _repo: string;

  constructor(options: GitAuthOptions = {}) {
    const defaultRepo = options.defaultRepo ?? 'AppCloud_Store';
    this.options = {
      defaultRepo,
      extensions: options.extensions ?? [],
      autoCreateRepo: options.autoCreateRepo ?? true,
      fetchImpl: options.fetchImpl ?? fetch.bind(globalThis),
    };
    this._repo = defaultRepo;
  }

  public get profile(): GitUserProfile | null {
    return this._profile;
  }

  public get username(): string {
    return this._profile?.username ?? '';
  }

  public get repo(): string {
    return this._repo;
  }

  public setRepo(repoName: string): void {
    this._repo = repoName.trim() || this.options.defaultRepo;
  }

  public get token(): string {
    return this._token;
  }

  public isAuthenticated(): boolean {
    return this._profile !== null && this._profile.mode !== 'none';
  }

  public hasWriteAccess(): boolean {
    return (
      this._profile !== null &&
      (this._profile.mode === 'oauth' || this._profile.mode === 'pat') &&
      this._token.length > 0
    );
  }

  public getHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.v3+json',
      ...extra,
    };
    if (this._token) {
      headers['Authorization'] = `token ${this._token}`;
    }
    return headers;
  }

  /**
   * Authenticate with a GitHub Personal Access Token (Fine-Grained PAT or Classic PAT).
   */
  public async loginWithPAT(token: string, usernameOverride?: string, repoName?: string): Promise<GitUserProfile> {
    const cleanedToken = token.trim();
    if (!cleanedToken) {
      throw new Error('Personal Access Token cannot be empty');
    }
    if (repoName) {
      this.setRepo(repoName);
    }

    this._token = cleanedToken;
    const res = await this.options.fetchImpl('https://api.github.com/user', {
      headers: this.getHeaders(),
    });

    if (!res.ok) {
      this._token = '';
      throw new Error(`GitHub authentication failed (HTTP ${res.status})`);
    }

    const data = await res.json();
    const resolvedUsername = usernameOverride?.trim() || data.login;
    this._profile = {
      username: resolvedUsername,
      name: data.name || resolvedUsername,
      avatarUrl: data.avatar_url,
      profileUrl: data.html_url,
      mode: 'pat',
    };
    return this._profile;
  }

  /**
   * Authenticate in Read-Only mode using a public GitHub username.
   */
  public async loginReadOnly(username: string, repoName?: string): Promise<GitUserProfile> {
    const cleanedUser = username.trim();
    if (!cleanedUser) {
      throw new Error('GitHub username cannot be empty');
    }
    if (repoName) {
      this.setRepo(repoName);
    }

    this._token = '';
    const res = await this.options.fetchImpl(`https://api.github.com/users/${cleanedUser}`, {
      headers: this.getHeaders(),
    });

    if (!res.ok) {
      throw new Error(`GitHub user "${cleanedUser}" not found (HTTP ${res.status})`);
    }

    const data = await res.json();
    this._profile = {
      username: data.login || cleanedUser,
      name: data.name || data.login || cleanedUser,
      avatarUrl: data.avatar_url,
      profileUrl: data.html_url,
      mode: 'readonly',
    };
    return this._profile;
  }

  public logout(): void {
    this._profile = null;
    this._token = '';
    this._repo = this.options.defaultRepo;
  }
}
