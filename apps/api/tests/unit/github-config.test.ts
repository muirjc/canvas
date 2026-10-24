import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

/** canvas-3s5.1: GitHub App settings (parseGitHubConfig, via loadConfig). A bad key fails at startup. */
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const pkcs1 = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const load = (env: Record<string, string | undefined>) => loadConfig({ NODE_ENV: 'test', ...env });

describe('GitHub configuration', () => {
  it('is undefined (integration off) when unset, partly set, or "unset"', () => {
    expect(load({}).github).toBeUndefined();
    expect(load({ GITHUB_APP_ID: '123' }).github).toBeUndefined();
    expect(load({ GITHUB_APP_PRIVATE_KEY: pkcs8 }).github).toBeUndefined();
    expect(load({ GITHUB_APP_ID: 'unset', GITHUB_APP_PRIVATE_KEY: pkcs8 }).github).toBeUndefined();
    expect(load({ GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: 'unset' }).github).toBeUndefined();
    expect(load({ GITHUB_APP_ID: '  ', GITHUB_APP_PRIVATE_KEY: pkcs8 }).github).toBeUndefined();
  });

  it('accepts a PEM, a PKCS#1 PEM, a PEM with literal \\n escapes, and base64 of the PEM', () => {
    const variants = [pkcs8, pkcs1, pkcs8.trim().replace(/\n/g, '\\n'), Buffer.from(pkcs8).toString('base64'), `  ${Buffer.from(pkcs1).toString('base64')}\n`];
    for (const key of variants) {
      const github = load({ GITHUB_APP_ID: '4242', GITHUB_APP_PRIVATE_KEY: key }).github;
      expect(github, key.slice(0, 30)).toBeDefined();
      expect(github!.appId).toBe('4242');
      expect(github!.privateKey.type).toBe('private');
      expect(github!.privateKey.asymmetricKeyType).toBe('rsa');
    }
  });

  it('defaults the API to api.github.com and trims a trailing slash', () => {
    expect(load({ GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: pkcs8 }).github!.apiUrl).toBe('https://api.github.com');
    expect(load({ GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: pkcs8, GITHUB_APP_API_URL: 'https://ghe.example.com/api/v3/' }).github!.apiUrl).toBe('https://ghe.example.com/api/v3');
  });

  it('throws at startup for a bad key or a non-numeric app id', () => {
    expect(() => load({ GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: 'not a key' })).toThrow(/GITHUB_APP_PRIVATE_KEY/);
    expect(() => load({ GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----' })).toThrow(/GITHUB_APP_PRIVATE_KEY/);
    expect(() => load({ GITHUB_APP_ID: 'abc', GITHUB_APP_PRIVATE_KEY: pkcs8 })).toThrow(/numeric/);
  });

  it('rejects the public half of a key (the App must sign, not verify)', () => {
    const publicPem = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(() => load({ GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: publicPem })).toThrow(/GITHUB_APP_PRIVATE_KEY/);
  });

  it('rejects a non-https API URL except for localhost and 127.0.0.1', () => {
    const base = { GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: pkcs8 };
    expect(() => load({ ...base, GITHUB_APP_API_URL: 'http://api.github.com' })).toThrow(/https/);
    expect(() => load({ ...base, GITHUB_APP_API_URL: 'http://github.example.com' })).toThrow(/https/);
    expect(() => load({ ...base, GITHUB_APP_API_URL: 'http://localhost.evil.com' })).toThrow(/https/);
    expect(() => load({ ...base, GITHUB_APP_API_URL: 'not a url' })).toThrow();
    expect(load({ ...base, GITHUB_APP_API_URL: 'http://localhost:4010' }).github!.apiUrl).toBe('http://localhost:4010');
    expect(load({ ...base, GITHUB_APP_API_URL: 'http://127.0.0.1:4010/' }).github!.apiUrl).toBe('http://127.0.0.1:4010');
  });
});

describe('publicUrl', () => {
  it('uses CANVAS_PUBLIC_URL, else the first WEB_ORIGINS entry, else localhost; no trailing slash', () => {
    expect(load({ CANVAS_PUBLIC_URL: 'https://canvas.example.com/' }).publicUrl).toBe('https://canvas.example.com');
    expect(load({ WEB_ORIGINS: 'https://a.example.com, https://b.example.com' }).publicUrl).toBe('https://a.example.com');
    expect(load({}).publicUrl).toBe('http://localhost:5173');
  });
});
