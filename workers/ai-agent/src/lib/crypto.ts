/**
 * AES-256-GCM envelope encryption for agent HL keys and user BYOK API keys.
 *
 * Ciphertext layout (base64): iv (12B) || auth tag (16B) || data.
 * The KMS key lives only in the Railway env (`AGENT_KMS_KEY`, 32-byte hex),
 * so a Supabase-only compromise cannot recover plaintext keys.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../config.js';

const IV_LEN = 12;
const TAG_LEN = 16;

function kmsKey(): Buffer {
  const key = Buffer.from(config.agentKmsKey, 'hex');
  if (key.length !== 32) {
    throw new Error('AGENT_KMS_KEY must be 32 bytes of hex (64 hex chars)');
  }
  return key;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', kmsKey(), iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, data]).toString('base64');
}

export function decryptSecret(ciphertext: string): string {
  const raw = Buffer.from(ciphertext, 'base64');
  if (raw.length < IV_LEN + TAG_LEN + 1) {
    throw new Error('Ciphertext too short');
  }
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const data = raw.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', kmsKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
