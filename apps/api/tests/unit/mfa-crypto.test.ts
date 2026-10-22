import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from '../../src/auth/mfa-crypto.js';

describe('mfa-crypto', () => {
  const key = randomBytes(32);
  const secret = 'JBSWY3DPEHPK3PXP';

  it('round-trips and does not contain the plaintext', () => {
    const stored = encryptSecret(secret, key);
    expect(stored).toMatch(/^v1:/);
    expect(stored).not.toContain(secret);
    expect(decryptSecret(stored, key)).toBe(secret);
  });

  it('uses a fresh IV each time', () => {
    expect(encryptSecret(secret, key)).not.toBe(encryptSecret(secret, key));
  });

  it('throws on a tampered ciphertext or tag', () => {
    const [v, iv, tag, ct] = encryptSecret(secret, key).split(':');
    const flip = (b64: string) => {
      const buf = Buffer.from(b64, 'base64');
      buf[0] ^= 1;
      return buf.toString('base64');
    };
    expect(() => decryptSecret([v, iv, tag, flip(ct)].join(':'), key)).toThrow();
    expect(() => decryptSecret([v, iv, flip(tag), ct].join(':'), key)).toThrow();
  });

  it('throws with the wrong key', () => {
    expect(() => decryptSecret(encryptSecret(secret, key), randomBytes(32))).toThrow();
  });

  it('throws on an unrecognized format', () => {
    expect(() => decryptSecret('v2:a:b:c', key)).toThrow(/format/);
    expect(() => decryptSecret('garbage', key)).toThrow(/format/);
  });
});
