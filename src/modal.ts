/**
 * Drop-in GitHub Authentication Modal UI (`GitAuthModal`).
 * Can be mounted into any DOM element in a static web app or game to provide
 * one-click GitHub OAuth, Personal Access Token (PAT), or Read-Only Username login.
 */
import { GitCloudAuth, GitUserProfile } from './auth.js';

export interface GitAuthModalOptions {
  title?: string;
  subtitle?: string;
  onSuccess?: (profile: GitUserProfile) => void;
  onError?: (error: Error) => void;
}

export class GitAuthModal {
  private container: HTMLElement | null = null;

  constructor(
    public readonly auth: GitCloudAuth,
    public readonly modalOptions: GitAuthModalOptions = {}
  ) {}

  /**
   * Open the GitHub login modal inside the target DOM element (or `id`).
   */
  public open(target: HTMLElement | string): void {
    if (typeof document === 'undefined') return;
    const elem = typeof target === 'string' ? document.getElementById(target) : target;
    if (!elem) return;

    this.container = elem;
    this.container.style.display = 'flex';
    this.renderMainView();
  }

  /** Close and clear the modal. */
  public close(): void {
    if (!this.container) return;
    this.container.innerHTML = '';
    this.container.style.display = 'none';
  }

  private renderMainView(): void {
    if (!this.container) return;
    const title = this.modalOptions.title ?? 'GitHub Cloud Login';
    const subtitle =
      this.modalOptions.subtitle ?? 'Connect your GitHub account for cloud storage & multiplayer';

    this.container.innerHTML = `
      <div class="gitauth-header" style="display:flex;justify-content:space-between;align-items:center;width:100%;">
        <h3 style="margin:0;font-size:1.05rem;">${title}</h3>
        <button id="gitauth-close" style="background:none;border:none;color:inherit;font-size:1.3rem;cursor:pointer;">&times;</button>
      </div>
      <p style="margin:6px 0 12px;font-size:0.82rem;opacity:0.8;">${subtitle}</p>
      <div style="width:100%;margin-bottom:10px;">
        <label style="display:block;font-size:0.76rem;margin-bottom:4px;">Workspace Repository</label>
        <input id="gitauth-repo" type="text" value="${this.auth.repo}" placeholder="${this.auth.options.defaultRepo}" style="width:100%;padding:8px;border-radius:6px;border:1px solid #30363d;background:#0d1117;color:#e6edf3;" />
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;width:100%;">
        <button id="gitauth-oauth-btn" style="padding:10px;border-radius:6px;border:1px solid #30363d;background:#21262d;color:#fff;cursor:pointer;font-weight:600;">Login with GitHub OAuth</button>
        <button id="gitauth-pat-btn" style="padding:10px;border-radius:6px;border:none;background:#1f6feb;color:#fff;cursor:pointer;font-weight:600;">Login with Personal Access Token</button>
        <button id="gitauth-user-btn" style="padding:10px;border-radius:6px;border:none;background:#238636;color:#fff;cursor:pointer;font-weight:600;">Read-Only via Username</button>
      </div>
    `;

    this.container.querySelector('#gitauth-close')?.addEventListener('click', () => this.close());

    const getRepoVal = (): string => {
      const input = this.container?.querySelector('#gitauth-repo') as HTMLInputElement | null;
      return input?.value.trim() || this.auth.options.defaultRepo;
    };

    this.container.querySelector('#gitauth-oauth-btn')?.addEventListener('click', async () => {
      try {
        this.auth.setRepo(getRepoVal());
        const profile = await this.auth.loginWithOAuth();
        if (profile) {
          this.modalOptions.onSuccess?.(profile);
        }
        this.close();
      } catch (err) {
        this.modalOptions.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    });

    this.container.querySelector('#gitauth-pat-btn')?.addEventListener('click', () => {
      this.auth.setRepo(getRepoVal());
      this.renderCredentialsView(true);
    });

    this.container.querySelector('#gitauth-user-btn')?.addEventListener('click', () => {
      this.auth.setRepo(getRepoVal());
      this.renderCredentialsView(false);
    });
  }

  private renderCredentialsView(isPAT: boolean): void {
    if (!this.container) return;
    this.container.innerHTML = `
      <div class="gitauth-header" style="display:flex;justify-content:space-between;align-items:center;width:100%;">
        <h3 style="margin:0;font-size:1.05rem;">${isPAT ? 'PAT Authentication' : 'Public Read-Only Mode'}</h3>
        <button id="gitauth-close" style="background:none;border:none;color:inherit;font-size:1.3rem;cursor:pointer;">&times;</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;width:100%;margin:12px 0;">
        <input id="gitauth-username" type="text" placeholder="GitHub Username" style="width:100%;padding:8px;border-radius:6px;border:1px solid #30363d;background:#0d1117;color:#e6edf3;" />
        ${
          isPAT
            ? '<input id="gitauth-token" type="password" placeholder="Fine-Grained PAT (github_pat_...)" style="width:100%;padding:8px;border-radius:6px;border:1px solid #30363d;background:#0d1117;color:#e6edf3;" />'
            : ''
        }
      </div>
      <button id="gitauth-submit" style="width:100%;padding:10px;border-radius:6px;border:none;background:#1f6feb;color:#fff;cursor:pointer;font-weight:600;">Connect</button>
    `;

    this.container.querySelector('#gitauth-close')?.addEventListener('click', () => this.close());
    this.container.querySelector('#gitauth-submit')?.addEventListener('click', async () => {
      const userEl = this.container?.querySelector('#gitauth-username') as HTMLInputElement | null;
      const tokenEl = this.container?.querySelector('#gitauth-token') as HTMLInputElement | null;
      const username = userEl?.value.trim() || '';
      const token = tokenEl?.value.trim() || '';

      try {
        const profile = isPAT
          ? await this.auth.loginWithPAT(token, username || undefined)
          : await this.auth.loginReadOnly(username);
        this.modalOptions.onSuccess?.(profile);
        this.close();
      } catch (err) {
        this.modalOptions.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }
}
