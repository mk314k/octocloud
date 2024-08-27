/**
 * GitHub authentication (`GitCloudAuth`).
 *
 * Defaults:
 *   - `oauthScope`: `'public_repo'`
 *   - `persistence`: `'session'` (`sessionStorage`)
 *   - Repository write sandbox via `allowedRepos` and `protectedRepos`
 */

export type AuthMode = 'oauth' | 'pat' | 'readonly' | 'none';
export type StoragePersistence = 'session' | 'local' | 'memory';

export interface GitUserProfile {
  username: string;
  name?: string;
  avatarUrl?: string;
  profileUrl?: string;
  mode: AuthMode;
}

export interface GitAuthOptions {
  /** Default repository name used for file storage (default: `'AppCloud_Store'`) */
  defaultRepo?: string;
  /** Repository names permitted for write operations (defaults to `[defaultRepo]`) */
  allowedRepos?: string[];
  /** Repository names that are always read-only */
  protectedRepos?: string[];
  /** Restrict writes strictly to `allowedRepos` (default: `false`) */
  strictRepoSandbox?: boolean;
  /** File extension filter when listing repository files (e.g. `['.json', '.md']`) */
  extensions?: string[];
  /** GitHub OAuth App Client ID (required for `loginWithOAuth`) */
  oauthClientId?: string;
  /** OAuth code-to-token exchange endpoint URL (required for `loginWithOAuth`) */
  tokenExchangeUrl?: string;
  /** OAuth redirect URI (defaults to `window.location.origin + window.location.pathname`) */
  redirectUri?: string;
  /** OAuth scope (default: `'public_repo'`) */
  oauthScope?: 'public_repo' | 'repo' | string;
  /** Create the target public repository on first write/list if it does not exist */
  autoCreateRepo?: boolean;
  /** Session storage backend: `'session'` (default), `'local'`, or `'memory'` */
  persistence?: StoragePersistence;
  /** Storage key name, or `false` to disable storage persistence */
  storageKey?: string | false;
  /** Custom `fetch` implementation */
  fetchImpl?: typeof fetch;
}

export type AuthStateListener = (profile: GitUserProfile | null) => void;

const DEFAULT_STORAGE_KEY = 'octocloud_auth_session';
const VALID_REPO_NAME_REGEX = /^[a-zA-Z0-9._-]{1,100}$/;

export class GitCloudAuth {
  public readonly options: Required<Omit<GitAuthOptions, 'storageKey' | 'fetchImpl'>> & {
    storageKey: string | false;
    fetchImpl: typeof fetch;
  };

  private _profile: GitUserProfile | null = null;
  private _token: string = '';
  private _repo: string;
  private _listeners: Set<AuthStateListener> = new Set();

  constructor(options: GitAuthOptions = {}) {
    const defaultRedirect =
      typeof window !== 'undefined' ? window.location.origin + window.location.pathname : '';
    const defaultRepo = options.defaultRepo ?? 'AppCloud_Store';

    this.options = {
      defaultRepo,
      allowedRepos: options.allowedRepos ?? [defaultRepo],
      protectedRepos: options.protectedRepos ?? [],
      strictRepoSandbox: options.strictRepoSandbox ?? false,
      extensions: options.extensions ?? [],
      oauthClientId: options.oauthClientId ?? '',
      tokenExchangeUrl: options.tokenExchangeUrl ?? '',
      redirectUri: options.redirectUri ?? defaultRedirect,
      oauthScope: options.oauthScope ?? 'public_repo',
      autoCreateRepo: options.autoCreateRepo ?? true,
      persistence: options.persistence ?? 'session',
      storageKey: options.storageKey === undefined ? DEFAULT_STORAGE_KEY : options.storageKey,
      fetchImpl: options.fetchImpl ?? fetch.bind(globalThis),
    };

    this._repo = defaultRepo;
    this.restoreSession();
  }

  /** Authenticated user profile, or `null` when logged out. */
  public get profile(): GitUserProfile | null {
    return this._profile;
  }

  /** Active GitHub username, or empty string when logged out. */
  public get username(): string {
    return this._profile?.username ?? '';
  }

  /** Active repository name. */
  public get repo(): string {
    return this._repo;
  }

  /**
   * Validate and set the active repository name.
   */
  public setRepo(repoName: string): void {
    const trimmed = repoName.trim() || this.options.defaultRepo;
    if (!VALID_REPO_NAME_REGEX.test(trimmed) || trimmed === '.' || trimmed === '..') {
      throw new Error(`Invalid repository name "${trimmed}"`);
    }
    this._repo = trimmed;
    if (!this.options.strictRepoSandbox && !this.options.allowedRepos.includes(trimmed)) {
      this.options.allowedRepos.push(trimmed);
    }
    this.saveSession();
  }

  /**
   * Verify that writing to `repoName` is permitted by the sandbox configuration.
   */
  public assertWriteAllowed(repoName = this._repo): void {
    if (!this.hasWriteAccess()) {
      throw new Error('Write access (OAuth or PAT) is required');
    }
    const lower = repoName.toLowerCase();
    if (lower.endsWith('.github.io')) {
      throw new Error(`Security Sandbox: Writing to GitHub Pages root repository "${repoName}" is blocked`);
    }
    if (this.options.protectedRepos.some((r) => r.toLowerCase() === lower)) {
      throw new Error(`Security Sandbox: Repository "${repoName}" is protected and read-only`);
    }
    if (
      this.options.strictRepoSandbox &&
      !this.options.allowedRepos.some((r) => r.toLowerCase() === lower)
    ) {
      throw new Error(
        `Security Sandbox: Repository "${repoName}" is not in the allowedRepos list (${this.options.allowedRepos.join(', ')})`
      );
    }
  }

  /** Access token for `Authorization` headers. */
  public get token(): string {
    return this._token;
  }

  /** Whether a session is active. */
  public isAuthenticated(): boolean {
    return this._profile !== null && this._profile.mode !== 'none';
  }

  /** Whether the active session has write credentials (`oauth` or `pat`). */
  public hasWriteAccess(): boolean {
    return (
      this._profile !== null &&
      (this._profile.mode === 'oauth' || this._profile.mode === 'pat') &&
      this._token.length > 0
    );
  }

  /** Build request headers for GitHub API calls. */
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

  /** Subscribe to authentication state changes. Returns an unsubscribe function. */
  public onAuthStateChange(listener: AuthStateListener): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  private notifyListeners(): void {
    for (const listener of this._listeners) {
      listener(this._profile);
    }
  }

  /**
   * Authenticate with a Personal Access Token against `GET /user`.
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

    this.saveSession();
    this.notifyListeners();
    return this._profile;
  }

  /**
   * Initialize a read-only session for a public GitHub username via `GET /users/:username`.
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

    this.saveSession();
    this.notifyListeners();
    return this._profile;
  }

  /**
   * Initiate the GitHub OAuth redirect flow, or complete the callback if `?code=` is present.
   */
  public async loginWithOAuth(repoName?: string): Promise<GitUserProfile | null> {
    if (repoName) {
      this.setRepo(repoName);
    }
    if (!this.options.oauthClientId) {
      throw new Error('oauthClientId must be configured in GitAuthOptions to use loginWithOAuth()');
    }

    if (typeof window !== 'undefined') {
      const urlParams = new URLSearchParams(window.location.search);
      const code = urlParams.get('code');
      if (code) {
        return this.handleOAuthCallback(code);
      }

      const authUrl =
        `https://github.com/login/oauth/authorize` +
        `?client_id=${encodeURIComponent(this.options.oauthClientId)}` +
        `&redirect_uri=${encodeURIComponent(this.options.redirectUri)}` +
        `&scope=${encodeURIComponent(this.options.oauthScope)}`;

      window.location.href = authUrl;
    }
    return null;
  }

  /**
   * Exchange an OAuth authorization `code` for an access token via `tokenExchangeUrl`.
   */
  public async handleOAuthCallback(code?: string): Promise<GitUserProfile | null> {
    let oauthCode = code;
    if (!oauthCode && typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      oauthCode = params.get('code') ?? undefined;
    }
    if (!oauthCode) {
      return null;
    }
    if (!this.options.tokenExchangeUrl) {
      throw new Error('tokenExchangeUrl must be configured in GitAuthOptions to complete OAuth token exchange');
    }

    const separator = this.options.tokenExchangeUrl.includes('?') ? '&' : '?';
    const exchangeUrl = `${this.options.tokenExchangeUrl}${separator}code=${encodeURIComponent(oauthCode)}`;
    const tokenRes = await this.options.fetchImpl(exchangeUrl);
    if (!tokenRes.ok) {
      throw new Error(`OAuth token exchange failed (HTTP ${tokenRes.status})`);
    }

    const tokenData = await tokenRes.json();
    const accessToken: string = tokenData.token || tokenData.access_token;
    if (!accessToken) {
      throw new Error('OAuth exchange response did not include a token');
    }

    this._token = accessToken;
    const userRes = await this.options.fetchImpl('https://api.github.com/user', {
      headers: this.getHeaders(),
    });
    if (!userRes.ok) {
      this._token = '';
      throw new Error(`Failed to fetch OAuth user profile (HTTP ${userRes.status})`);
    }

    const userData = await userRes.json();
    this._profile = {
      username: userData.login,
      name: userData.name || userData.login,
      avatarUrl: userData.avatar_url,
      profileUrl: userData.html_url,
      mode: 'oauth',
    };

    if (typeof window !== 'undefined' && window.history?.replaceState) {
      const cleanUrl = window.location.origin + window.location.pathname + window.location.hash;
      window.history.replaceState({}, document.title, cleanUrl);
    }

    this.saveSession();
    this.notifyListeners();
    return this._profile;
  }

  /** Clear active credentials and remove persisted session state. */
  public logout(): void {
    this._profile = null;
    this._token = '';
    this._repo = this.options.defaultRepo;
    const storage = this.getWebStorage();
    if (this.options.storageKey && storage) {
      storage.removeItem(this.options.storageKey);
    }
    this.notifyListeners();
  }

  private getWebStorage(): Storage | null {
    if (!this.options.storageKey || this.options.persistence === 'memory') {
      return null;
    }
    if (this.options.persistence === 'session' && typeof sessionStorage !== 'undefined') {
      return sessionStorage;
    }
    if (this.options.persistence === 'local' && typeof localStorage !== 'undefined') {
      return localStorage;
    }
    return null;
  }

  private saveSession(): void {
    const storage = this.getWebStorage();
    if (!storage || !this.options.storageKey || !this._profile) return;
    try {
      const payload = JSON.stringify({
        profile: this._profile,
        token: this._token,
        repo: this._repo,
      });
      storage.setItem(this.options.storageKey, payload);
    } catch {
      // Ignore storage quota errors
    }
  }

  private restoreSession(): void {
    const storage = this.getWebStorage();
    if (!storage || !this.options.storageKey) return;
    try {
      const raw = storage.getItem(this.options.storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.profile && parsed.profile.username) {
        this._profile = parsed.profile;
        this._token = parsed.token || '';
        this._repo = parsed.repo || this.options.defaultRepo;
      }
    } catch {
      // Ignore corrupted entries
    }
  }
}
