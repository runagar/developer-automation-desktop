import { describe, expect, it } from 'vitest';
import { parsePatch } from '../../main/githubDiff';
import { findDiffMatches, splitSearchTokens } from './diffSearch';

describe('diff search', () => {
  it('finds case-insensitive partial matches in context, removed and added lines across hunks', () => {
    // Given
    const { hunks } = parsePatch('@@ -1,2 +1,2 @@\n prefixTARGETsuffix target\n-old Target\n+new TARGET\n@@ -9 +9 @@\n target');

    // When
    const result = findDiffMatches(hunks, 'tarGET');

    // Then
    expect(result.count).toBe(5);
    expect([...result.byLine.values()].flat()).toEqual([
      { from: 6, to: 12, index: 0 },
      { from: 19, to: 25, index: 1 },
      { from: 4, to: 10, index: 2 },
      { from: 4, to: 10, index: 3 },
      { from: 0, to: 6, index: 4 },
    ]);
  });

  it('treats punctuation literally and handles empty or missing matches', () => {
    // Given
    const { hunks } = parsePatch('@@ -1 +1 @@\n a.*[x] A.*[X] aaa');

    // When
    const literal = findDiffMatches(hunks, 'a.*[x]');
    const empty = findDiffMatches(hunks, '');
    const missing = findDiffMatches(hunks, 'absent');

    // Then
    expect(literal.count).toBe(2);
    expect(empty.count).toBe(0);
    expect(empty.byLine.size).toBe(0);
    expect(missing.count).toBe(0);
  });

  it('preserves syntax and text when a match crosses token boundaries', () => {
    // Given
    const { hunks } = parsePatch('@@ -1 +1 @@\n return "Value";');
    const matches = findDiffMatches(hunks, 'rn "va').byLine.get(hunks[0].lines[0])!;
    const tokens = [
      { text: 'return', kind: 'keyword' as const },
      { text: ' ', kind: null },
      { text: '"Value"', kind: 'string' as const },
      { text: ';', kind: null },
    ];

    // When
    const result = splitSearchTokens(tokens, matches);

    // Then
    expect(result.map((token) => token.text).join('')).toBe('return "Value";');
    expect(result.filter((token) => token.matchIndex === 0)).toEqual([
      { text: 'rn', kind: 'keyword', matchIndex: 0 },
      { text: ' ', kind: null, matchIndex: 0 },
      { text: '"Va', kind: 'string', matchIndex: 0 },
    ]);
  });
});
