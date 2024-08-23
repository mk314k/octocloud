/**
 * Serverless Multiplayer SDK for GitHub-Authenticated Web Apps & Games (`src/multiplayer.ts`).
 *
 * Provides `GitPeerRoom` for real-time peer-to-peer WebRTC (`RTCDataChannel`) multiplayer
 * where every packet carries the sender's GitHub identity (`username`, `avatarUrl`) and sequence number.
 */
import { GitCloudAuth, GitUserProfile } from './auth';
import { encodeBase64UTF8, decodeBase64UTF8 } from './base64';

export interface PlayerIdentity {
  username: string;
  name?: string;
  avatarUrl?: string;
  repo?: string;
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
  protected remoteSessionId: string = '';
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
