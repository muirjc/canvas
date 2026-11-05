import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readEnvFile } from '../../../../scripts/dotenv.mjs';

const dir = mkdtempSync(join(tmpdir(), 'dotenv-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let counter = 0;
function read(content: string): Record<string, string> {
  const path = join(dir, `env-${counter++}`);
  writeFileSync(path, content);
  return readEnvFile(path);
}

describe('readEnvFile', () => {
  it('returns an empty object when the file does not exist', () => {
    expect(readEnvFile(join(dir, 'missing'))).toEqual({});
  });

  it('reads KEY=VALUE lines', () => {
    expect(read('A=1\nB=two words\n')).toEqual({ A: '1', B: 'two words' });
  });

  it('skips blank lines and comments, including commented-out settings', () => {
    expect(read('# note\n\n   \n# DB_CLIENT=postgres\nA=1\n')).toEqual({ A: '1' });
  });

  it('strips matching single or double quotes', () => {
    expect(read('A="x y"\nB=\'z\'\n')).toEqual({ A: 'x y', B: 'z' });
  });

  it('drops a trailing comment after an unquoted value but keeps # inside quotes', () => {
    expect(read('A=value # note\nB="a # b"\nC=\'c # d\' \n')).toEqual({
      A: 'value',
      B: 'a # b',
      C: 'c # d',
    });
  });

  it('accepts an export prefix', () => {
    expect(read('export A=1\n')).toEqual({ A: '1' });
  });

  it('handles CRLF line endings', () => {
    expect(read('A=1\r\nB=2\r\n')).toEqual({ A: '1', B: '2' });
  });

  it('lets the last of a repeated key win', () => {
    expect(read('A=1\nA=2\n')).toEqual({ A: '2' });
  });

  it('reads apps/api-py/.env.example as SQLite, not the commented Postgres values', () => {
    const values = readEnvFile(join(__dirname, '../../../api-py/.env.example'));
    expect(values.DB_CLIENT).toBe('sqlite');
    expect(values.DATABASE_URL).toBe('./data/canvas.db');
    expect(Object.values(values).some((v) => v.includes('postgres'))).toBe(false);
  });
});
