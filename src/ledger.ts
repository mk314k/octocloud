/**
 * Append-only hash-chained ledger (`GitLedger<Payload>`).
 *
 * Entries are linked via SHA-256 `prevHash` pointers over canonicalized JSON payloads,
 * with optional WebCrypto ECDSA P-256 signatures and binary Merkle root computation.
 */
import { GitRepoStore, sanitizeRepoPath } from './store';

export interface LedgerEntry<Payload = unknown> {
  /** 0-based sequential index */
  index: number;
  /** Entry identifier */
  id: string;
  /** SHA-256 hex digest of the preceding entry (`'0'.repeat(64)` at index 0) */
  prevHash: string;
  /** SHA-256 hex digest of the canonical entry body */
  hash: string;
  /** Author username */
  author: string;
  /** Unix timestamp in milliseconds */
  timestamp: number;
  /** Entry payload */
  payload: Payload;
  /** Optional hex-encoded ECDSA P-256 signature over `hash` */
  signature?: string;
  /** Public key in JWK format corresponding to `signature` */
  publicKeyJwk?: JsonWebKey;
}

export interface LedgerVerificationResult {
  valid: boolean;
  entryCount: number;
  merkleRoot: string;
  brokenAtIndex?: number;
  reason?: string;
}

export interface LedgerKeyPair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicKeyJwk: JsonWebKey;
}

export const GENESIS_PREV_HASH = '0'.repeat(64);

function canonicalizeJSON(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJSON(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const pairs: string[] = [];
  for (const key of sortedKeys) {
    if (obj[key] !== undefined) {
      pairs.push(`${JSON.stringify(key)}:${canonicalizeJSON(obj[key])}`);
    }
  }
  return `{${pairs.join(',')}}`;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Compute a lowercase SHA-256 hex digest of a UTF-8 string via WebCrypto.
 */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return bytesToHex(new Uint8Array(digest));
}

