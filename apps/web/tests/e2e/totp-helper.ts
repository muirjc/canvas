import { createHmac } from 'node:crypto';

/** RFC 6238 (SHA-1, 6 digits, 30s) for e2e specs -- deliberately independent of apps/api's code. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text.replace(/[\s=-]/g, '').toUpperCase()) {
    value = (value << 5) | ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const currentStep = (): number => Math.floor(Date.now() / 30_000);

export function totp(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** Waits until at least `seconds` remain in the current 30s step, so a code can't expire mid-request. */
export async function waitForSafeWindow(seconds = 3): Promise<void> {
  const remaining = 30_000 - (Date.now() % 30_000);
  if (remaining < seconds * 1000) await new Promise((resolve) => setTimeout(resolve, remaining + 200));
}

/** A code the server will accept: never one at or before `lastUsedStep` (replay protection). */
export async function nextCode(secret: string, lastUsedStep: number): Promise<{ code: string; step: number }> {
  await waitForSafeWindow();
  const step = Math.max(currentStep(), lastUsedStep + 1);
  return { code: totp(secret, step), step };
}

/** A 6-digit code that is not valid in the current +-1 window. */
export function wrongCode(secret: string): string {
  const step = currentStep();
  const valid = [step - 1, step, step + 1].map((s) => totp(secret, s));
  return ['000000', '111111', '222222'].find((c) => !valid.includes(c))!;
}
