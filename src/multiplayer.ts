/**
 * WebRTC P2P (`GitPeerRoom`) and repository-backed turn-based (`GitRepoRoom`) multiplayer rooms.
 *
 * - `GitPeerRoom`: exchanges SDP offer/answer tickets and verifies remote peer identity
 *   against `rooms/<roomId>.proof.json` in the peer's GitHub repository.
 * - `GitRepoRoom`: synchronizes turn-based state across player repositories (`rooms/<roomId>.json`)
 *   without sharing access tokens.
 */
import { GitCloudAuth, GitUserProfile } from './auth';
import { GitRepoStore } from './store';
import { encodeBase64UTF8, decodeBase64UTF8 } from './base64';

export interface PlayerIdentity {
  username: string;
  name?: string;
  avatarUrl?: string;
  repo?: string;
}

export interface SessionProof {
  username: string;
  repo: string;
  roomId: string;
  sessionId: string;
  issuedAt: number;
}

export interface MultiplayerMessage<T = unknown> {
  seq: number;
  sessionId: string;
  roomId: string;
  type: string;
  sender: PlayerIdentity;
  payload: T;
  timestamp: number;
}

export interface PeerSignalTicket {
  type: 'offer' | 'answer';
  sdp: string;
  player: PlayerIdentity;
  roomId: string;
  sessionId: string;
}

export type MessageListener<T = unknown> = (msg: MultiplayerMessage<T>) => void;
export type PeerConnectionListener = (peer: PlayerIdentity, state: 'connected' | 'disconnected') => void;

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

function generateSessionId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  const time = Date.now().toString(36);
  return `sess_${time}_${rand}`;
}

export class GitPeerRoom<T = unknown> {
  public readonly roomId: string;
  public readonly sessionId: string;
  private seq = 0;
  private lastRemoteSeq = -1;
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private remotePlayer: PlayerIdentity | null = null;
  private remoteSessionId: string = '';
  private msgListeners: Set<MessageListener<T>> = new Set();
  private connListeners: Set<PeerConnectionListener> = new Set();
  private iceServers: RTCIceServer[];

  constructor(
    public readonly auth: GitCloudAuth,
    roomId = 'default-room',
    iceServers: RTCIceServer[] = DEFAULT_ICE_SERVERS
  ) {
    this.roomId = roomId;
    this.sessionId = generateSessionId();
    this.iceServers = iceServers;
  }

  public getLocalPlayer(): PlayerIdentity {
    const profile: GitUserProfile | null = this.auth.profile;
    return {
      username: profile?.username || 'guest',
      name: profile?.name || profile?.username || 'Guest',
      avatarUrl: profile?.avatarUrl,
      repo: this.auth.repo,
    };
  }

  public getRemotePlayer(): PlayerIdentity | null {
    return this.remotePlayer;
  }

  public async publishIdentityProof(store: GitRepoStore): Promise<SessionProof> {
    const proof: SessionProof = {
      username: this.auth.username,
      repo: this.auth.repo,
      roomId: this.roomId,
      sessionId: this.sessionId,
      issuedAt: Date.now(),
    };
    await store.writeJSON(`rooms/${this.roomId}.proof.json`, proof, `Publish session proof for ${this.roomId}`);
    return proof;
  }

  public async verifyPeerIdentity(
    store: GitRepoStore,
    peerUsername = this.remotePlayer?.username,
    expectedSessionId = this.remoteSessionId,
    peerRepo = this.remotePlayer?.repo || this.auth.repo
  ): Promise<boolean> {
    if (!peerUsername || !expectedSessionId) {
      return false;
    }
    try {
      const proof = await store.readJSON<SessionProof>(
        `rooms/${this.roomId}.proof.json`,
        peerUsername,
        peerRepo
      );
      return (
        proof.username.toLowerCase() === peerUsername.toLowerCase() &&
        proof.roomId === this.roomId &&
        proof.sessionId === expectedSessionId
      );
    } catch {
      return false;
    }
  }

  public onMessage(listener: MessageListener<T>): () => void {
    this.msgListeners.add(listener);
    return () => this.msgListeners.delete(listener);
  }

  public onPeerStateChange(listener: PeerConnectionListener): () => void {
    this.connListeners.add(listener);
    return () => this.connListeners.delete(listener);
  }

  public async createOfferTicket(): Promise<string> {
    this.cleanup();
    this.pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const dataChannel = this.pc.createDataChannel(`gitroom-${this.roomId}`);
    this.bindDataChannel(dataChannel);

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this.waitForIceGatheringComplete(this.pc);

    const ticket: PeerSignalTicket = {
      type: 'offer',
      sdp: this.pc.localDescription?.sdp || '',
      player: this.getLocalPlayer(),
      roomId: this.roomId,
      sessionId: this.sessionId,
    };
    return encodeBase64UTF8(JSON.stringify(ticket));
  }

  public async acceptOfferAndCreateAnswer(offerTicketBase64: string): Promise<string> {
    const offerTicket = this.decodeTicket(offerTicketBase64);
    if (offerTicket.type !== 'offer') {
      throw new Error('Expected an "offer" ticket from host');
    }

    this.remotePlayer = offerTicket.player;
    this.remoteSessionId = offerTicket.sessionId;
    this.cleanup();
    this.pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.pc.ondatachannel = (event) => {
      this.bindDataChannel(event.channel);
    };

    await this.pc.setRemoteDescription({ type: 'offer', sdp: offerTicket.sdp });
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await this.waitForIceGatheringComplete(this.pc);

    const answerTicket: PeerSignalTicket = {
      type: 'answer',
      sdp: this.pc.localDescription?.sdp || '',
      player: this.getLocalPlayer(),
      roomId: offerTicket.roomId,
      sessionId: this.sessionId,
    };
    return encodeBase64UTF8(JSON.stringify(answerTicket));
  }

  public async completeHandshake(answerTicketBase64: string): Promise<PlayerIdentity> {
    if (!this.pc) {
      throw new Error('Host must call createOfferTicket() before completeHandshake()');
    }
    const answerTicket = this.decodeTicket(answerTicketBase64);
    if (answerTicket.type !== 'answer') {
      throw new Error('Expected an "answer" ticket from guest');
    }

    this.remotePlayer = answerTicket.player;
    this.remoteSessionId = answerTicket.sessionId;
    await this.pc.setRemoteDescription({ type: 'answer', sdp: answerTicket.sdp });
    return this.remotePlayer;
  }

  public send(type: string, payload: T): MultiplayerMessage<T> {
    this.seq += 1;
    const message: MultiplayerMessage<T> = {
      seq: this.seq,
      sessionId: this.sessionId,
      roomId: this.roomId,
      type,
      sender: this.getLocalPlayer(),
      payload,
      timestamp: Date.now(),
    };

    if (this.channel && this.channel.readyState === 'open') {
      this.channel.send(JSON.stringify(message));
    }
    return message;
  }

  public decodeTicket(ticketBase64: string): PeerSignalTicket {
    const jsonStr = decodeBase64UTF8(ticketBase64.trim());
    const parsed = JSON.parse(jsonStr) as PeerSignalTicket;
    if (!parsed || (parsed.type !== 'offer' && parsed.type !== 'answer') || !parsed.player?.username) {
      throw new Error('Invalid multiplayer signaling ticket');
    }
    return parsed;
  }

  private bindDataChannel(ch: RTCDataChannel): void {
    this.channel = ch;
    ch.onopen = () => {
      if (this.remotePlayer) {
        for (const listener of this.connListeners) {
          listener(this.remotePlayer, 'connected');
        }
      }
    };
    ch.onclose = () => {
      if (this.remotePlayer) {
        for (const listener of this.connListeners) {
          listener(this.remotePlayer, 'disconnected');
        }
      }
    };
    ch.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as MultiplayerMessage<T>;
        if (typeof msg.seq === 'number' && msg.seq <= this.lastRemoteSeq) {
          return;
        }
        if (typeof msg.seq === 'number') {
          this.lastRemoteSeq = msg.seq;
        }
        for (const listener of this.msgListeners) {
          listener(msg);
        }
      } catch {
        // Ignore malformed packets
      }
    };
  }

  private waitForIceGatheringComplete(pc: RTCPeerConnection, timeoutMs = 4000): Promise<void> {
    if (pc.iceGatheringState === 'complete') {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pc.removeEventListener('icegatheringstatechange', checkState);
        resolve();
      }, timeoutMs);

      function checkState() {
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(timer);
          pc.removeEventListener('icegatheringstatechange', checkState);
          resolve();
        }
      }
      pc.addEventListener('icegatheringstatechange', checkState);
    });
  }

  public cleanup(): void {
    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
  }
}

export interface SharedMatchState<S = unknown> {
  roomId: string;
  players: PlayerIdentity[];
  turn: string;
  version: number;
  state: S;
  updatedAt: number;
  history: MultiplayerMessage<unknown>[];
}

/**
 * Repository-backed turn-based room (`GitRepoRoom`).
 * Reads and writes `rooms/<roomId>.json` across player repositories and resolves
 * the highest `version` state via `getLatestFederatedState()`.
 */
export class GitRepoRoom<S = unknown> {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastVersion = -1;

  constructor(
    public readonly store: GitRepoStore,
    public readonly roomId: string = 'match-1'
  ) {}

  private get roomFilePath(): string {
    return `rooms/${this.roomId}.json`;
  }

  public async createMatch(initialState: S, opponentUsername?: string): Promise<SharedMatchState<S>> {
    const hostPlayer: PlayerIdentity = {
      username: this.store.auth.username || 'host',
      name: this.store.auth.profile?.name,
      avatarUrl: this.store.auth.profile?.avatarUrl,
      repo: this.store.auth.repo,
    };

    const players: PlayerIdentity[] = [hostPlayer];
    if (opponentUsername) {
      players.push({ username: opponentUsername.trim(), repo: this.store.auth.repo });
    }

    const match: SharedMatchState<S> = {
      roomId: this.roomId,
      players,
      turn: hostPlayer.username,
      version: 1,
      state: initialState,
      updatedAt: Date.now(),
      history: [],
    };

    await this.store.writeJSON(this.roomFilePath, match, `Create match ${this.roomId}`);
    this.lastVersion = 1;
    return match;
  }

  public async getMatchState(ownerUsername?: string, repoName?: string): Promise<SharedMatchState<S>> {
    return this.store.readJSON<SharedMatchState<S>>(this.roomFilePath, ownerUsername, repoName);
  }

  public async getLatestFederatedState(peerUsernames: string[] = []): Promise<SharedMatchState<S>> {
    const candidates: SharedMatchState<S>[] = [];
    const owners = Array.from(new Set([this.store.auth.username, ...peerUsernames].filter(Boolean)));

    for (const owner of owners) {
      try {
        const state = await this.getMatchState(owner, this.store.auth.repo);
        if (state && state.roomId === this.roomId) {
          candidates.push(state);
        }
      } catch {
        // Peer has not written a state file for this room yet
      }
    }

    if (candidates.length === 0) {
      throw new Error(`No match state found for room "${this.roomId}" across [${owners.join(', ')}]`);
    }

    candidates.sort((a, b) => b.version - a.version || b.updatedAt - a.updatedAt);
    return candidates[0];
  }

  public async submitMove(
    nextState: S,
    nextTurnUsername?: string,
    moveAction: unknown = null,
    peerUsernames: string[] = []
  ): Promise<SharedMatchState<S>> {
    const match =
      peerUsernames.length > 0
        ? await this.getLatestFederatedState(peerUsernames)
        : await this.getMatchState();

    const sender: PlayerIdentity = {
      username: this.store.auth.username || 'player',
      name: this.store.auth.profile?.name,
      avatarUrl: this.store.auth.profile?.avatarUrl,
      repo: this.store.auth.repo,
    };

    if (!match.players.some((p) => p.username.toLowerCase() === sender.username.toLowerCase())) {
      match.players.push(sender);
    }

    match.state = nextState;
    if (nextTurnUsername) {
      match.turn = nextTurnUsername;
    }
    match.version += 1;
    match.updatedAt = Date.now();
    match.history.push({
      seq: match.version,
      sessionId: `repo_${this.roomId}`,
      roomId: this.roomId,
      type: 'MOVE',
      sender,
      payload: moveAction,
      timestamp: match.updatedAt,
    });

    await this.store.writeJSON(
      this.roomFilePath,
      match,
      `Move #${match.version} by ${sender.username} in ${this.roomId}`
    );
    this.lastVersion = match.version;
    return match;
  }

  public startPolling(
    onUpdate: (match: SharedMatchState<S>) => void,
    peerUsernames: string[] = [],
    intervalMs = 3000
  ): void {
    this.stopPolling();
    this.pollTimer = setInterval(async () => {
      try {
        const latest = await this.getLatestFederatedState(peerUsernames);
        if (latest.version > this.lastVersion) {
          this.lastVersion = latest.version;
          onUpdate(latest);
        }
      } catch {
        // Ignore transient network errors during polling
      }
    }, intervalMs);
  }

  public stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
