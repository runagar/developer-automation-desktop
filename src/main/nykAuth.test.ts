import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  clearAuthFileCache, clearLatch, isLatched, latchRejected,
  parseAuthnBody, parseAuthnRedirect,
} from './nykAuth';

describe('parseAuthnRedirect', () => {
  it('extracts a token from the success fragment', () => {
    const result = parseAuthnRedirect(
      'https://apidocs.nykredit.it/cb.html#access_token=abc123&state=x&expires_in=3600'
    );
    expect(result).toEqual({ token: 'abc123' });
  });

  it('extracts the error from the failure fragment', () => {
    const result = parseAuthnRedirect(
      'https://apidocs.nykredit.it/cb.html#error=access_denied&state=x&logToken=null'
    );
    expect(result).toEqual({ error: 'access_denied' });
  });

  it('returns nothing for a location with no fragment', () => {
    expect(parseAuthnRedirect('https://apidocs.nykredit.it/cb.html')).toEqual({});
  });

  it('returns nothing for a missing location', () => {
    expect(parseAuthnRedirect(null)).toEqual({});
  });
});

describe('parseAuthnBody', () => {
  it('finds a token in a rendered redirect link', () => {
    const body = '<a href="https://apidocs.nykredit.it/cb.html#access_token=zzz&state=x">go</a>';
    expect(parseAuthnBody(body)).toEqual({ token: 'zzz' });
  });

  it('finds an error in a rendered redirect link', () => {
    const body = 'moved to https://apidocs.nykredit.it/cb.html#error=access_denied&amp;state=x';
    expect(parseAuthnBody(body)).toEqual({ error: 'access_denied' });
  });
});

describe('rejection latch', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dad-auth-'));
    clearAuthFileCache();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    clearAuthFileCache();
  });

  const a = { username: 'abcd', password: 'old-password' };
  const b = { username: 'abcd', password: 'another-wrong' };
  const good = { username: 'abcd', password: 'correct-horse' };

  it('does not latch credentials that were never rejected', () => {
    expect(isLatched(dir, a)).toBe(false);
  });

  it('latches the credentials that were rejected', () => {
    latchRejected(dir, a);
    expect(isLatched(dir, a)).toBe(true);
  });

  it('leaves other credentials unlatched so a corrected password can be tried', () => {
    latchRejected(dir, a);
    expect(isLatched(dir, good)).toBe(false);
  });

  it('keeps an earlier rejection when a different attempt also fails', () => {
    latchRejected(dir, a);
    latchRejected(dir, b);
    expect(isLatched(dir, a)).toBe(true);
    expect(isLatched(dir, b)).toBe(true);
  });

  it('is cleared entirely by a successful login', () => {
    latchRejected(dir, a);
    latchRejected(dir, b);
    clearLatch(dir);
    expect(isLatched(dir, a)).toBe(false);
    expect(isLatched(dir, b)).toBe(false);
  });

  it('survives a restart', () => {
    latchRejected(dir, a);
    clearAuthFileCache();
    expect(isLatched(dir, a)).toBe(true);
  });

  it('never stores the password itself', () => {
    latchRejected(dir, a);
    const raw = fs.readFileSync(path.join(dir, 'auth-state.json'), 'utf-8');
    expect(raw).not.toContain('old-password');
    expect(raw).not.toContain('abcd');
  });

  it('writes the state file at mode 0600', () => {
    latchRejected(dir, a);
    const mode = fs.statSync(path.join(dir, 'auth-state.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('ignores empty credentials', () => {
    latchRejected(dir, { username: '', password: '' });
    expect(isLatched(dir, { username: '', password: '' })).toBe(false);
  });
});
