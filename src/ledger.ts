/**
 * Append-only hash-chained ledger (`GitLedger<Payload>`).
 *
 * Entries are linked via SHA-256 `prevHash` pointers over canonicalized JSON payloads,
 * with optional WebCrypto ECDSA P-256 signatures and binary Merkle root computation.
 */
import { GitRepoStore, sanitizeRepoPath } from './store.js';

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

/**
 * Generate an extractable WebCrypto ECDSA P-256 keypair.
 */
export async function generateLedgerKeyPair(): Promise<LedgerKeyPair> {
  const pair = await globalThis.crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
  const publicKeyJwk = await globalThis.crypto.subtle.exportKey('jwk', pair.publicKey);
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicKeyJwk,
  };
}

/**
 * Sign `hashHex` with an ECDSA P-256 private key and return a hex-encoded signature.
 */
export async function signLedgerHash(hashHex: string, privateKey: CryptoKey): Promise<string> {
  const data = new TextEncoder().encode(hashHex);
  const sig = await globalThis.crypto.subtle.sign(
    { name: 'ECDSA', hash: { name: 'SHA-256' } },
    privateKey,
    data
  );
  return bytesToHex(new Uint8Array(sig));
}

/**
 * Verify a hex-encoded ECDSA P-256 signature against a JWK public key.
 */
export async function verifyLedgerSignature(
  hashHex: string,
  signatureHex: string,
  publicKeyJwk: JsonWebKey
): Promise<boolean> {
  try {
    const pubKey = await globalThis.crypto.subtle.importKey(
      'jwk',
      publicKeyJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );
    const data = new TextEncoder().encode(hashHex);
    const sigBytes = hexToBytes(signatureHex);
    return await globalThis.crypto.subtle.verify(
      { name: 'ECDSA', hash: { name: 'SHA-256' } },
      pubKey,
      sigBytes as BufferSource,
      data
    );
  } catch {
    return false;
  }
}

/**
 * Compute a binary SHA-256 Merkle root over a list of 64-char hex hashes or arbitrary serializable items.
 */
export async function computeMerkleRoot(items: readonly (string | unknown)[]): Promise<string> {
  if (items.length === 0) {
    return GENESIS_PREV_HASH;
  }

  let layer: string[] = await Promise.all(
    items.map((item) =>
      typeof item === 'string' && /^[0-9a-f]{64}$/i.test(item)
        ? Promise.resolve(item.toLowerCase())
        : sha256Hex(canonicalizeJSON(item))
    )
  );

  while (layer.length > 1) {
    const nextLayer: string[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i];
      const right = i + 1 < layer.length ? layer[i + 1] : left;
      const combined = await sha256Hex(`${left}:${right}`);
      nextLayer.push(combined);
    }
    layer = nextLayer;
  }

  return layer[0];
}

export class GitLedger<Payload = unknown> {
  public readonly ledgerName: string;

  constructor(
    public readonly store: GitRepoStore,
    ledgerName = 'main',
    public readonly options: { ownerOverride?: string; repoOverride?: string } = {}
  ) {
    this.ledgerName = sanitizeRepoPath(ledgerName).replace(/\//g, '_');
  }

  private get ledgerPath(): string {
    return `ledgers/${this.ledgerName}.json`;
  }

  /**
   * Compute the canonical SHA-256 digest over an entry's header and payload.
   */
  public static async computeEntryHash<P>(entry: {
    index: number;
    id: string;
    prevHash: string;
    author: string;
    timestamp: number;
    payload: P;
  }): Promise<string> {
    const canonical = canonicalizeJSON({
      index: entry.index,
      id: entry.id,
      prevHash: entry.prevHash,
      author: entry.author,
      timestamp: entry.timestamp,
      payload: entry.payload,
    });
    return sha256Hex(canonical);
  }

  /**
   * Load all entries from `ledgers/<ledgerName>.json`.
   */
  public async getEntries(
    ownerOverride = this.options.ownerOverride,
    repoOverride = this.options.repoOverride
  ): Promise<LedgerEntry<Payload>[]> {
    try {
      const entries = await this.store.readJSON<LedgerEntry<Payload>[]>(
        this.ledgerPath,
        ownerOverride,
        repoOverride
      );
      return Array.isArray(entries) ? entries : [];
    } catch {
      return [];
    }
  }

  /**
   * Append a new entry to the ledger, linking `prevHash` to the current head.
   */
  public async append(
    payload: Payload,
    options: {
      id?: string;
      timestamp?: number;
      signer?: { privateKey: CryptoKey; publicKeyJwk: JsonWebKey };
    } = {}
  ): Promise<LedgerEntry<Payload>> {
    const entries = await this.getEntries();
    const index = entries.length;
    const prevHash = index === 0 ? GENESIS_PREV_HASH : entries[index - 1].hash;
    const timestamp = options.timestamp ?? Date.now();
    const id = options.id || `entry_${index}_${timestamp.toString(36)}`;
    const author = this.store.auth.username || 'anonymous';

    const hash = await GitLedger.computeEntryHash({
      index,
      id,
      prevHash,
      author,
      timestamp,
      payload,
    });

    const entry: LedgerEntry<Payload> = {
      index,
      id,
      prevHash,
      hash,
      author,
      timestamp,
      payload,
    };

    if (options.signer) {
      entry.signature = await signLedgerHash(hash, options.signer.privateKey);
      entry.publicKeyJwk = options.signer.publicKeyJwk;
    }

    entries.push(entry);
    await this.store.writeJSON(
      this.ledgerPath,
      entries,
      `Append ledger entry #${index} (${id}) to ${this.ledgerName}`
    );
    return entry;
  }

  /**
   * Verify index sequence, `prevHash` chain, SHA-256 entry hashes, and optional ECDSA signatures.
   */
  public async verifyChain(customEntries?: LedgerEntry<Payload>[]): Promise<LedgerVerificationResult> {
    const entries = customEntries ?? (await this.getEntries());

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.index !== i) {
        return {
          valid: false,
          entryCount: entries.length,
          merkleRoot: GENESIS_PREV_HASH,
          brokenAtIndex: i,
          reason: `Expected index ${i} but found ${entry.index}`,
        };
      }

      const expectedPrev = i === 0 ? GENESIS_PREV_HASH : entries[i - 1].hash;
      if (entry.prevHash !== expectedPrev) {
        return {
          valid: false,
          entryCount: entries.length,
          merkleRoot: GENESIS_PREV_HASH,
          brokenAtIndex: i,
          reason: `Broken prevHash link at index ${i}`,
        };
      }

      const expectedHash = await GitLedger.computeEntryHash({
        index: entry.index,
        id: entry.id,
        prevHash: entry.prevHash,
        author: entry.author,
        timestamp: entry.timestamp,
        payload: entry.payload,
      });

      if (entry.hash !== expectedHash) {
        return {
          valid: false,
          entryCount: entries.length,
          merkleRoot: GENESIS_PREV_HASH,
          brokenAtIndex: i,
          reason: `Entry hash mismatch at index ${i}`,
        };
      }

      if (entry.signature || entry.publicKeyJwk) {
        if (!entry.signature || !entry.publicKeyJwk) {
          return {
            valid: false,
            entryCount: entries.length,
            merkleRoot: GENESIS_PREV_HASH,
            brokenAtIndex: i,
            reason: `Incomplete signature metadata at index ${i}`,
          };
        }
        const sigOk = await verifyLedgerSignature(entry.hash, entry.signature, entry.publicKeyJwk);
        if (!sigOk) {
          return {
            valid: false,
            entryCount: entries.length,
            merkleRoot: GENESIS_PREV_HASH,
            brokenAtIndex: i,
            reason: `Invalid cryptographic signature at index ${i}`,
          };
        }
      }
    }

    const merkleRoot = await computeMerkleRoot(entries.map((e) => e.hash));
    return {
      valid: true,
      entryCount: entries.length,
      merkleRoot,
    };
  }
}
