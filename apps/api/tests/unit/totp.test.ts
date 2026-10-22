import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, generateTotpSecret, otpauthUri, timeStep, totpCode, verifyTotp } from '../../src/auth/totp.js';

// RFC 6238 Appendix B, SHA-1 key "12345678901234567890" (ASCII), 8-digit codes; ours are the last 6 digits.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));
const RFC_VECTORS: [number, string][] = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
];

describe('totp', () => {
  it.each(RFC_VECTORS)('matches the RFC 6238 vector at t=%i', (seconds, expected) => {
    expect(totpCode(RFC_SECRET, timeStep(seconds * 1000))).toBe(expected);
  });

  it('base32 encodes the RFC key to the well-known string', () => {
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('base32 round-trips arbitrary bytes and tolerates spaces, dashes, padding and lower case', () => {
    for (const length of [1, 2, 3, 4, 5, 19, 20, 21]) {
      const bytes = Buffer.from(Array.from({ length }, (_, i) => (i * 37 + length) % 256));
      expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
    }
    expect(base32Decode('gezd gnbv-GY3TQOJQ====').toString('ascii')).toBe('1234567890');
  });

  it('base32Decode rejects characters outside the alphabet', () => {
    expect(() => base32Decode('GEZD1')).toThrow(/base32/i);
  });

  it('generates a 160-bit base32 secret, different each time', () => {
    const a = generateTotpSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(generateTotpSecret()).not.toBe(a);
  });

  describe('verifyTotp', () => {
    const NOW = 1_700_000_000_000;
    const step = timeStep(NOW);
    const code = (s: number) => totpCode(RFC_SECRET, s);

    it('accepts the current step and one either side, returning the matched step', () => {
      expect(verifyTotp(RFC_SECRET, code(step), NOW, null)).toBe(step);
      expect(verifyTotp(RFC_SECRET, code(step - 1), NOW, null)).toBe(step - 1);
      expect(verifyTotp(RFC_SECRET, code(step + 1), NOW, null)).toBe(step + 1);
    });

    it('refuses steps two or more away', () => {
      expect(verifyTotp(RFC_SECRET, code(step - 2), NOW, null)).toBeNull();
      expect(verifyTotp(RFC_SECRET, code(step + 2), NOW, null)).toBeNull();
    });

    it('refuses a step at or before the last used step (replay), but accepts a later one in the window', () => {
      expect(verifyTotp(RFC_SECRET, code(step), NOW, step)).toBeNull();
      expect(verifyTotp(RFC_SECRET, code(step - 1), NOW, step)).toBeNull();
      expect(verifyTotp(RFC_SECRET, code(step + 1), NOW, step)).toBe(step + 1);
    });

    it('ignores whitespace inside the code', () => {
      const c = code(step);
      expect(verifyTotp(RFC_SECRET, `${c.slice(0, 3)} ${c.slice(3)}`, NOW, null)).toBe(step);
    });

    it('rejects non-digit, wrong-length and empty input', () => {
      for (const bad of ['', 'abcdef', '12345', '1234567', '12345a', '١٢٣٤٥٦']) {
        expect(verifyTotp(RFC_SECRET, bad, NOW, null), bad).toBeNull();
      }
    });
  });

  it('builds an otpauth URI an authenticator app understands', () => {
    const uri = new URL(otpauthUri('ABCDEFGH', 'ann@example.com'));
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.host).toBe('totp');
    expect(decodeURIComponent(uri.pathname)).toBe('/Canvas:ann@example.com');
    expect(Object.fromEntries(uri.searchParams)).toEqual({ secret: 'ABCDEFGH', issuer: 'Canvas', algorithm: 'SHA1', digits: '6', period: '30' });
  });
});
