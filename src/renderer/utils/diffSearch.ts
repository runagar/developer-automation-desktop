import { DiffHunk, DiffLine } from '../../main/githubDiff';
import { SyntaxToken } from './diffSyntax';

interface SearchMatch {
  from: number;
  to: number;
  index: number;
}

export interface DiffSearch {
  byLine: Map<DiffLine, SearchMatch[]>;
  count: number;
}

export function findDiffMatches(hunks: DiffHunk[], query: string): DiffSearch {
  const byLine = new Map<DiffLine, SearchMatch[]>();
  let count = 0;
  if (!query) return { byLine, count };
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      const matches = Array.from(line.content.matchAll(pattern), (match) => ({
        from: match.index!,
        to: match.index! + match[0].length,
        index: count++,
      }));
      if (matches.length) byLine.set(line, matches);
    }
  }
  return { byLine, count };
}

export function splitSearchTokens(
  tokens: SyntaxToken[], matches: SearchMatch[]
): (SyntaxToken & { matchIndex: number | null })[] {
  const result: (SyntaxToken & { matchIndex: number | null })[] = [];
  let offset = 0;
  let matchIndex = 0;
  for (const token of tokens) {
    const end = offset + token.text.length;
    let from = offset;
    while (from < end) {
      while (matchIndex < matches.length && matches[matchIndex].to <= from) matchIndex++;
      const match = matches[matchIndex];
      const inside = match && match.from <= from;
      const to = Math.min(end, match ? (inside ? match.to : match.from) : end);
      result.push({
        text: token.text.slice(from - offset, to - offset),
        kind: token.kind,
        matchIndex: inside ? match.index : null,
      });
      from = to;
    }
    offset = end;
  }
  return result;
}
