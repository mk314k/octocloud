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
  /** GitHub OAuth App Client ID (required only when using loginWithOAuth) */
  oauthClientId?: string;
  /** OAuth code-to-token exchange endpoint URL (required only when using loginWithOAuth) */
  tokenExchangeUrl?: string;
  /** OAuth redirect URI (defaults to current window.location.origin + pathname) */
  redirectUri?: string;
  /** OAuth scope */
  oauthScope?: string;
  /** Automatically create the target public repository on login if it does not exist */
  autoCreateRepo?: boolean;
  /** Storage key name (or false to disable storage) */
  storageKey?: string | false;
  /** Optional custom fetch implementation (useful for testing or SSR) */
  fetchImpl?: typeof fetch;
}

export type AuthStateListener = (profile: GitUserProfile | null) => void;

const DEFAULT_STORAGE_KEY = 'octocloud_auth_session';

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
      extensions: options.extensions ?? [],
      oauthClientId: options.oauthClientId ?? '',
      tokenExchangeUrl: options.tokenExchangeUrl ?? '',
      redirectUri: options.redirectUri ?? defaultRedirect,
      oauthScope: options.oauthScope ?? 'public_repo',
      autoCreateRepo: options.autoCreateRepo ?? true,
      storageKey: options.storageKey === undefined ? DEFAULT_STORAGE_KEY : options.storageKey,
      fetchImpl: options.fetchImpl ?? fetch.bind(globalThis),
    };

    this._repo = defaultRepo;
    this.restoreSession();
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
    this.saveSession();
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

  public onAuthStateChange(listener: AuthStateListener): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  private notifyListeners(): void {
    for (const listener of this._listeners) {
      listener(this._profile);
    }
  }

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

  public logout(): void {
    this._profile = null;
    this._token = '';
    this._repo = this.options.defaultRepo;
    if (this.options.storageKey && typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(this.options.storageKey);
    }
    this.notifyListeners();
  }

  private saveSession(): void {
    if (!this.options.storageKey || typeof sessionStorage === 'undefined' || !this._profile) return;
    try {
      const payload = JSON.stringify({
        profile: this._profile,
        token: this._token,
        repo: this._repo,
      });
      sessionStorage.setItem(this.options.storageKey, payload);
    } catch {
      // Ignore storage quota errors
    }
  }

  private restoreSession(): void {
    if (!this.options.storageKey || typeof sessionStorage === 'undefined') return;
    try {
      const raw = sessionStorage.getItem(this.options.storageKey);
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
