/**
 * Client-side encrypted file store (`GitEncryptedStore`).
 *
 * Derives a 256-bit AES-GCM key from a user passphrase via `PBKDF2-HMAC-SHA256`
 * and stores authenticated ciphertext envelopes under `<vaultDir>/<name>.enc.json`.
 */
import { GitRepoStore, sanitizeRepoPath } from './store';
import { encodeBase64UTF8, decodeBase64UTF8 } from './base64';

export interface EncryptedEnvelope {
  version: 1;
  cipher: 'AES-GCM-256';
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  /** Base64-encoded 16-byte PBKDF2 salt */
  saltBase64: string;
  /** Base64-encoded 12-byte AES-GCM initialization vector */
  ivBase64: string;
  /** Base64-encoded ciphertext and 128-bit authentication tag */
  ciphertextBase64: string;
  updatedAt: number;
}

export interface EncryptedVaultOptions {
  /** Repository directory prefix (default: `'vault'`) */
  vaultDir?: string;
  /** PBKDF2 iteration count (default: `100_000`) */
  iterations?: number;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const cleaned = base64.replace(/\s+/g, '');
  const binary = atob(cleaned);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

async function deriveAesGcmKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number
): Promise<CryptoKey> {
  if (!passphrase || passphrase.length < 1) {
    throw new Error('Passphrase cannot be empty for vault encryption/decryption');
  }
  const enc = new TextEncoder();
  const baseKey = await globalThis.crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return globalThis.crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

