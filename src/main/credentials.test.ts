import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  clearCredential, decodeEnvValue, encodeEnvValue, parseEnvFile, resolveCredential, saveCredential,
} from './credentials';

describe('env value encoding', () => {
  it('leaves an ordinary value bare', () => {
    expect(encodeEnvValue('abc123')).toBe('abc123');
    expect(encodeEnvValue('https://jira.example.com/')).toBe('https://jira.example.com/');
  });

  it('quotes values that would not survive a bare round-trip', () => {
    expect(encodeEnvValue('  padded  ')).toBe('"  padded  "');
    expect(encodeEnvValue('two\nlines')).toBe('"two\\nlines"');
    expect(encodeEnvValue('has"quote')).toBe('"has\\"quote"');
    expect(encodeEnvValue('back\\slash')).toBe('"back\\\\slash"');
  });

  it('round-trips every awkward value', () => {
    for (const value of ['  pad  ', 'a\nb', 'q"q', 'c:\\path', 'p@ss=word#1', 'ünïcodé']) {
      expect(decodeEnvValue(encodeEnvValue(value))).toBe(value);
    }
  });

  it('does not turn an escaped backslash followed by n into a newline', () => {
    // Regression: chained replaces unescaped \\n before \\\\, so the encoded
    // form of a literal backslash-then-n decoded as a real newline.
    const value = 'c:\\new\\pass';
    expect(decodeEnvValue(encodeEnvValue(value))).toBe(value);
    expect(decodeEnvValue(encodeEnvValue(value))).not.toContain('\n');
  });

  it('round-trips values that mix every escape', () => {
    for (const value of ['\\n', 'a\\nb\nc"d\\\\e', '\\\\', '"', '\\"']) {
      expect(decodeEnvValue(encodeEnvValue(value))).toBe(value);
    }
  });

  it('still parses bare values written by earlier versions', () => {
    expect(decodeEnvValue('plain-token')).toBe('plain-token');
  });
});

describe('credentials file', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dad-cred-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a password containing awkward characters', () => {
    const password = ' p@ss"word\\with=stuff ';
    saveCredential(dir, 'NYK_PASSWORD', password);
    expect(resolveCredential(dir, 'NYK_PASSWORD')).toBe(password);
  });

  it('does not let one value corrupt another', () => {
    saveCredential(dir, 'NYK_PASSWORD', 'line1\nNYK_USERNAME=injected');
    saveCredential(dir, 'NYK_USERNAME', 'abcd');
    expect(resolveCredential(dir, 'NYK_USERNAME')).toBe('abcd');
    expect(resolveCredential(dir, 'NYK_PASSWORD')).toBe('line1\nNYK_USERNAME=injected');
  });

  it('enforces mode 0600 even on a pre-existing permissive file', () => {
    const file = path.join(dir, 'credentials.env');
    fs.writeFileSync(file, 'ATLASSIAN_PAT=legacy\n', { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    saveCredential(dir, 'NYK_USERNAME', 'abcd');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('preserves other credentials when clearing one', () => {
    saveCredential(dir, 'NYK_USERNAME', 'abcd');
    saveCredential(dir, 'NYK_PASSWORD', 'secret');
    clearCredential(dir, 'NYK_PASSWORD');
    expect(resolveCredential(dir, 'NYK_USERNAME')).toBe('abcd');
    expect(resolveCredential(dir, 'NYK_PASSWORD')).toBe('');
  });

  it('reads a legacy unquoted file unchanged', () => {
    const file = path.join(dir, 'credentials.env');
    fs.writeFileSync(file, '# comment\nATLASSIAN_PAT=abc123\nATLASSIAN_BASE_URL=https://x.test/\n');
    const env = parseEnvFile(file);
    expect(env.ATLASSIAN_PAT).toBe('abc123');
    expect(env.ATLASSIAN_BASE_URL).toBe('https://x.test/');
  });
});
