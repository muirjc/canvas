import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** canvas-ez1.5: TOTP secrets at rest are AES-256-GCM encrypted (config.mfaEncryptionKey).
 *  Stored as "v1:<iv>:<tag>:<ciphertext>", base64 parts. */
export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(':');
}

export function decryptSecret(stored: string, key: Buffer): string {
  const [version, iv, tag, ciphertext] = stored.split(':');
  if (version !== 'v1' || !iv || !tag || !ciphertext) throw new Error('Unrecognized encrypted secret format');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
}
