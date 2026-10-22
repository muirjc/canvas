import { randomInt } from 'node:crypto';

/**
 * canvas-ez1.2: the one password policy for every local account password -- set by the user, or
 * generated as a one-time password. Length is what matters most (NIST SP 800-63B): at least 12
 * characters, no composition rules, and a check against the passwords attackers try first.
 */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;

const COMMON_PASSWORDS = new Set([
  '123456789012', '1234567890123', 'password1234', 'password12345', 'passwordpassword', 'qwertyuiopas',
  'qwerty123456', '1q2w3e4r5t6y', 'iloveyou1234', 'adminadmin123', 'administrator', 'letmein12345',
  'welcome12345', 'changeme1234', 'abc123456789', 'aaaaaaaaaaaa', '111111111111', '000000000000',
  'canvascanvas', 'canvas123456', 'trustno11234', 'football1234', 'baseball1234', 'superman1234',
]);

/** Returns why `password` is not acceptable, or null when it is. */
export function checkPasswordPolicy(password: string, context: { email?: string } = {}): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Passwords must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Passwords can be at most ${MAX_PASSWORD_LENGTH} characters.`;
  }
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower) || /^(.)\1+$/.test(password)) {
    return 'That password is too common. Choose something harder to guess.';
  }
  const localPart = context.email?.split('@')[0]?.toLowerCase();
  if (localPart && localPart.length >= 4 && lower.includes(localPart)) {
    return "Passwords can't contain your email address.";
  }
  return null;
}

// No 0/O, 1/l/I: one-time passwords are read off a screen and typed in by someone else.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A one-time password: 4 groups of 4 from a 55-character alphabet (~92 bits), e.g. "x7Kp-..." */
export function generateOneTimePassword(): string {
  const groups: string[] = [];
  for (let g = 0; g < 4; g++) {
    let group = '';
    for (let i = 0; i < 4; i++) group += ALPHABET[randomInt(ALPHABET.length)];
    groups.push(group);
  }
  return groups.join('-');
}
