import { describe, it, expect } from 'vitest';
import {
  KEY_MAX_LENGTH,
  normalizeKey,
  isValidKey,
  abbreviateRepo,
  uniqueKey,
} from './workspaceKeys';

describe('normalizeKey', () => {
  it('uppercases input', () => {
    expect(normalizeKey('abc')).toBe('ABC');
  });

  it('strips non-alphanumeric characters except - and _', () => {
    expect(normalizeKey('a-b_c.d')).toBe('A-B_CD');
    expect(normalizeKey('a@b!c')).toBe('ABC');
  });

  it('clamps to KEY_MAX_LENGTH', () => {
    expect(normalizeKey('abcdefghijkl')).toBe('ABCDEFGH');
    expect(normalizeKey('abcdefghijkl').length).toBe(KEY_MAX_LENGTH);
  });

  it('returns an empty string when nothing survives', () => {
    expect(normalizeKey('...')).toBe('');
  });
});

describe('isValidKey', () => {
  it('accepts normalized keys', () => {
    expect(isValidKey('RCR')).toBe(true);
    expect(isValidKey('A1')).toBe(true);
  });

  it('accepts hyphens and underscores', () => {
    expect(isValidKey('RS-CON')).toBe(true);
    expect(isValidKey('RS_CON')).toBe(true);
  });

  it('rejects empty keys', () => {
    expect(isValidKey('')).toBe(false);
  });

  it('rejects lowercase keys', () => {
    expect(isValidKey('rcr')).toBe(false);
  });

  it('rejects punctuation outside - and _', () => {
    expect(isValidKey('R.C')).toBe(false);
    expect(isValidKey('R C')).toBe(false);
  });

  it('rejects keys with no alphanumeric characters', () => {
    expect(isValidKey('--')).toBe(false);
    expect(isValidKey('_')).toBe(false);
  });

  it('rejects over-length keys', () => {
    expect(isValidKey('ABCDEFGHI')).toBe(false);
  });
});

describe('abbreviateRepo', () => {
  it('takes the initial of each part for multi-part names', () => {
    expect(abbreviateRepo('rs-consent-registry')).toBe('RCR');
  });

  it('takes the first three characters of a single-word name', () => {
    expect(abbreviateRepo('payments')).toBe('PAY');
    expect(abbreviateRepo('dad')).toBe('DAD');
  });

  it('handles a single word shorter than three characters', () => {
    expect(abbreviateRepo('ab')).toBe('AB');
  });

  it('handles mixed separators', () => {
    expect(abbreviateRepo('foo_bar.baz')).toBe('FBB');
    expect(abbreviateRepo('foo bar-baz_qux')).toBe('FBBQ');
  });

  it('ignores repeated and trailing separators', () => {
    expect(abbreviateRepo('foo--bar-')).toBe('FB');
  });

  it('strips characters outside A-Z0-9 without losing the initial', () => {
    expect(abbreviateRepo('@scope-#tag')).toBe('ST');
    expect(abbreviateRepo('my@repo')).toBe('MYR');
  });

  it('clamps long multi-part names', () => {
    expect(abbreviateRepo('a-b-c-d-e-f-g-h-i-j')).toBe('ABCDEFGH');
  });

  it('falls back when nothing usable remains', () => {
    expect(abbreviateRepo('...')).toBe('WS');
    expect(abbreviateRepo('')).toBe('WS');
  });
});

describe('uniqueKey', () => {
  it('returns the base when it is free', () => {
    expect(uniqueKey('RCR', new Set())).toBe('RCR');
  });

  it('suffixes a counter on collision', () => {
    expect(uniqueKey('RCR', new Set(['RCR']))).toBe('RCR2');
    expect(uniqueKey('RCR', new Set(['RCR', 'RCR2']))).toBe('RCR3');
  });

  it('truncates the base rather than losing the suffix', () => {
    const result = uniqueKey('ABCDEFGH', new Set(['ABCDEFGH']));
    expect(result).toBe('ABCDEFG2');
    expect(result.length).toBe(KEY_MAX_LENGTH);
  });

  it('keeps the counter when it grows past one digit', () => {
    const taken = new Set(['ABCDEFGH']);
    for (let n = 2; n <= 9; n++) taken.add(`ABCDEFG${n}`);
    const result = uniqueKey('ABCDEFGH', taken);
    expect(result).toBe('ABCDEF10');
    expect(result.length).toBe(KEY_MAX_LENGTH);
  });

  it('normalizes the base before comparing', () => {
    expect(uniqueKey('rcr', new Set(['RCR']))).toBe('RCR2');
  });

  it('falls back for an unusable base', () => {
    expect(uniqueKey('...', new Set())).toBe('WS');
  });
});
