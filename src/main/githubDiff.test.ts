import { describe, it, expect } from 'vitest';
import {
  anchorForLine, anchorForRange, anchorForSelection, lineMatchesAnchor, missingPatchReason, parsePatch, positionForNewLine,
  toSplitRows,
} from './githubDiff';

describe('parsePatch', () => {
  it('returns an empty result for a missing patch', () => {
    // Binary files and files past GitHub's size ceiling arrive with no patch
    // at all; they must render a placeholder, not crash the viewer.
    expect(parsePatch(null)).toEqual({ hunks: [], additions: 0, deletions: 0 });
    expect(parsePatch(undefined).hunks).toHaveLength(0);
    expect(parsePatch('').hunks).toHaveLength(0);
  });

  it('numbers context, additions and deletions independently', () => {
    const parsed = parsePatch(
      '@@ -10,3 +10,4 @@\n' +
      ' keep\n' +
      '-gone\n' +
      '+new one\n' +
      '+new two\n' +
      ' tail'
    );

    const [hunk] = parsed.hunks;
    expect(hunk.oldStart).toBe(10);
    expect(hunk.newStart).toBe(10);
    expect(hunk.lines.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
      ['context', 10, 10],
      ['del', 11, null],
      ['add', null, 11],
      ['add', null, 12],
      ['context', 12, 13],
    ]);
    expect(parsed.additions).toBe(2);
    expect(parsed.deletions).toBe(1);
  });

  it('treats an omitted hunk count as one, not zero', () => {
    // `@@ -1 +1 @@` is legal. Reading the missing count as zero desynchronises
    // every subsequent line number in the file.
    const parsed = parsePatch('@@ -1 +1 @@\n-old\n+new');
    expect(parsed.hunks[0].oldCount).toBe(1);
    expect(parsed.hunks[0].newCount).toBe(1);
    expect(parsed.hunks[0].lines[0].oldLine).toBe(1);
    expect(parsed.hunks[0].lines[1].newLine).toBe(1);
  });

  it('keeps multiple hunks separate and restarts numbering at each header', () => {
    const parsed = parsePatch(
      '@@ -1,2 +1,2 @@\n a\n-b\n+B\n' +
      '@@ -40,2 +40,2 @@ func main()\n c\n-d\n+D'
    );
    expect(parsed.hunks).toHaveLength(2);
    expect(parsed.hunks[1].header).toContain('func main()');
    expect(parsed.hunks[1].lines[0].oldLine).toBe(40);
    expect(parsed.deletions).toBe(2);
  });

  it('attaches "\\ No newline at end of file" to the preceding line', () => {
    const parsed = parsePatch('@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new');
    expect(parsed.hunks[0].lines).toHaveLength(2);
    expect(parsed.hunks[0].lines[0].noNewline).toBe(true);
    expect(parsed.hunks[0].lines[1].noNewline).toBe(false);
  });

  it('ignores the git preamble that precedes the first hunk', () => {
    const parsed = parsePatch(
      'diff --git a/x b/x\nindex 111..222 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b'
    );
    expect(parsed.hunks).toHaveLength(1);
    expect(parsed.hunks[0].lines).toHaveLength(2);
  });

  it('handles a whole-file addition and a whole-file deletion', () => {
    const added = parsePatch('@@ -0,0 +1,2 @@\n+one\n+two');
    expect(added.additions).toBe(2);
    expect(added.hunks[0].lines.every((l) => l.oldLine === null)).toBe(true);

    const removed = parsePatch('@@ -1,2 +0,0 @@\n-one\n-two');
    expect(removed.deletions).toBe(2);
    expect(removed.hunks[0].lines.every((l) => l.newLine === null)).toBe(true);
  });

  it('preserves an empty context line', () => {
    // A blank context line is the single character " ", and a truly empty
    // string can appear at the end of a patch; neither may shift numbering.
    const parsed = parsePatch('@@ -1,3 +1,3 @@\n a\n \n-b\n+B');
    expect(parsed.hunks[0].lines[1]).toMatchObject({ kind: 'context', content: '', oldLine: 2 });
  });
});

describe('toSplitRows', () => {
  it('zips a deletion run against the following addition run', () => {
    const [hunk] = parsePatch('@@ -1,3 +1,3 @@\n ctx\n-a\n-b\n+A\n+B').hunks;
    const rows = toSplitRows(hunk);
    expect(rows).toHaveLength(3);
    expect(rows[0].left?.content).toBe('ctx');
    expect(rows[0].right?.content).toBe('ctx');
    expect([rows[1].left?.content, rows[1].right?.content]).toEqual(['a', 'A']);
    expect([rows[2].left?.content, rows[2].right?.content]).toEqual(['b', 'B']);
  });

  it('spills the longer run into half-empty rows', () => {
    const [hunk] = parsePatch('@@ -1,1 +1,3 @@\n-a\n+A\n+B\n+C').hunks;
    const rows = toSplitRows(hunk);
    expect(rows).toHaveLength(3);
    expect(rows[1].left).toBeNull();
    expect(rows[2].left).toBeNull();
    expect(rows[2].right?.content).toBe('C');
  });

  it('puts the SAME line object on both sides of a context row', () => {
    // Callers must de-duplicate anything they collect per side: a consumer
    // that gathers, say, comment threads from `left` and `right` separately
    // would list every thread on an unchanged line twice.
    const [hunk] = parsePatch('@@ -1,2 +1,2 @@\n ctx\n-a\n+A').hunks;
    const [contextRow] = toSplitRows(hunk);
    expect(contextRow.left).toBe(contextRow.right);
  });

  it('does not pair additions that precede deletions', () => {
    // `+` then `-` is not a replacement; pairing them would show an edit that
    // did not happen.
    const [hunk] = parsePatch('@@ -1,2 +1,2 @@\n+A\n-a').hunks;
    const rows = toSplitRows(hunk);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ left: null, right: expect.objectContaining({ content: 'A' }) });
    expect(rows[1]).toEqual({ left: expect.objectContaining({ content: 'a' }), right: null });
  });
});

describe('anchorForLine', () => {
  it('anchors an added line on the right and a deleted line on the left', () => {
    const [hunk] = parsePatch('@@ -5,2 +5,2 @@\n-gone\n+kept').hunks;
    expect(anchorForLine(hunk.lines[0])).toEqual({ line: 5, side: 'LEFT' });
    expect(anchorForLine(hunk.lines[1])).toEqual({ line: 5, side: 'RIGHT' });
  });

  it('anchors a context line on the right', () => {
    const [hunk] = parsePatch('@@ -5,2 +7,2 @@\n ctx\n-x').hunks;
    expect(anchorForLine(hunk.lines[0])).toEqual({ line: 7, side: 'RIGHT' });
  });
});

describe('anchorForSelection', () => {
  it('anchors a multi-line addition to its first and last new lines', () => {
    const [hunk] = parsePatch('@@ -1,1 +1,3 @@\n ctx\n+a\n+b').hunks;
    expect(anchorForSelection(hunk, 1, 2)).toEqual({
      line: 3, side: 'RIGHT', startLine: 2, startSide: 'RIGHT',
    });
  });

  it('normalises a backwards selection', () => {
    const [hunk] = parsePatch('@@ -1,1 +1,3 @@\n ctx\n+a\n+b').hunks;
    expect(anchorForSelection(hunk, 2, 1)).toEqual(anchorForSelection(hunk, 1, 2));
  });

  it('spans a modified block as LEFT → RIGHT', () => {
    // GitHub takes `startSide` and `side` separately; a selection covering a
    // deletion and the addition that replaces it is expressed as the old
    // number on the left and the new number on the right. Verified against
    // real review comments, e.g. rust-lang/rust#163494.
    const [hunk] = parsePatch('@@ -1,2 +1,2 @@\n-a\n+A').hunks;
    expect(anchorForSelection(hunk, 0, 1)).toEqual({
      line: 1, side: 'RIGHT', startLine: 1, startSide: 'LEFT',
    });
  });

  it('spans a whole modified block from its first deletion to its last addition', () => {
    const [hunk] = parsePatch('@@ -10,3 +10,4 @@\n-a\n-b\n-c\n+A\n+B\n+C\n+D').hunks;
    expect(anchorForSelection(hunk, 0, 6)).toEqual({
      line: 13, side: 'RIGHT', startLine: 10, startSide: 'LEFT',
    });
  });

  it('refuses a mixed selection that runs right to left', () => {
    // An addition first and a deletion last has no representation: the range
    // would have to travel backwards through the diff.
    const [hunk] = parsePatch('@@ -10,3 +10,3 @@\n-a\n+A\n ctx\n-b\n+B').hunks;
    expect(anchorForSelection(hunk, 1, 3)).toBeNull();
  });

  it('ignores the other column when the selection is clamped to one side', () => {
    // Split view: dragging down the right-hand column crosses deletions that
    // sit between the endpoints in unified order but were never swept over.
    const [hunk] = parsePatch('@@ -10,3 +10,3 @@\n-a\n+A\n ctx\n-b\n+B').hunks;
    expect(anchorForSelection(hunk, 1, 4, 'RIGHT')).toEqual({
      line: 12, side: 'RIGHT', startLine: 10, startSide: 'RIGHT',
    });
    expect(anchorForSelection(hunk, 0, 3, 'LEFT')).toEqual({
      line: 12, side: 'LEFT', startLine: 10, startSide: 'LEFT',
    });
  });

  it('lets context lines join a left-side selection using their old numbers', () => {
    const [hunk] = parsePatch('@@ -10,3 +20,1 @@\n-a\n ctx\n-b').hunks;
    expect(anchorForSelection(hunk, 0, 2)).toEqual({
      line: 12, side: 'LEFT', startLine: 10, startSide: 'LEFT',
    });
  });

  it('returns null for a single-line selection', () => {
    const [hunk] = parsePatch('@@ -1,1 +1,2 @@\n+a').hunks;
    expect(anchorForSelection(hunk, 0, 0)).toBeNull();
  });

  it('returns null for an out-of-range index', () => {
    const [hunk] = parsePatch('@@ -1,1 +1,2 @@\n+a').hunks;
    expect(anchorForSelection(hunk, 0, 9)).toBeNull();
    expect(anchorForSelection(hunk, -1, 0)).toBeNull();
  });
});

describe('anchorForRange', () => {
  it('anchors a single line without a range', () => {
    const [hunk] = parsePatch('@@ -1,1 +1,2 @@\n+a').hunks;
    expect(anchorForRange(hunk, 0, 0)).toEqual({
      line: 1, side: 'RIGHT', startLine: null, startSide: null,
    });
  });

  it('collapses to a single line when a clamped selection covers only one', () => {
    // Two split rows can hold one commentable line on the chosen side, so the
    // index range says "multi" while the anchor must not: GitHub rejects a
    // range whose start equals its end.
    const [hunk] = parsePatch('@@ -1,2 +1,2 @@\n-a\n+A').hunks;
    expect(anchorForRange(hunk, 0, 1, 'RIGHT')).toEqual({
      line: 1, side: 'RIGHT', startLine: null, startSide: null,
    });
  });

  it('keeps the range when the selection really covers several lines', () => {
    const [hunk] = parsePatch('@@ -1,1 +1,3 @@\n ctx\n+a\n+b').hunks;
    expect(anchorForRange(hunk, 1, 2)).toEqual({
      line: 3, side: 'RIGHT', startLine: 2, startSide: 'RIGHT',
    });
  });

  it('returns null for an out-of-range index', () => {
    const [hunk] = parsePatch('@@ -1,1 +1,2 @@\n+a').hunks;
    expect(anchorForRange(hunk, 0, 9)).toBeNull();
  });
});

describe('lineMatchesAnchor', () => {
  it('places a right-side thread on the added line, not the deleted one', () => {
    const [hunk] = parsePatch('@@ -5,1 +5,1 @@\n-gone\n+kept').hunks;
    expect(lineMatchesAnchor(hunk.lines[0], { line: 5, side: 'RIGHT' })).toBe(false);
    expect(lineMatchesAnchor(hunk.lines[1], { line: 5, side: 'RIGHT' })).toBe(true);
  });

  it('places a left-side thread on the deleted line', () => {
    const [hunk] = parsePatch('@@ -5,1 +5,1 @@\n-gone\n+kept').hunks;
    expect(lineMatchesAnchor(hunk.lines[0], { line: 5, side: 'LEFT' })).toBe(true);
    expect(lineMatchesAnchor(hunk.lines[1], { line: 5, side: 'LEFT' })).toBe(false);
  });
});

describe('missingPatchReason', () => {
  it('reports a pure rename', () => {
    // Given
    const file = { status: 'renamed', additions: 0, deletions: 0 };

    // When
    const reason = missingPatchReason(file);

    // Then
    expect(reason).toBe('renamed');
  });

  it('reports a pure copy', () => {
    // Given
    const file = { status: 'copied', additions: 0, deletions: 0 };

    // When
    const reason = missingPatchReason(file);

    // Then
    expect(reason).toBe('copied');
  });

  it('treats a rename with changes but no patch as unavailable', () => {
    // Given
    const file = { status: 'renamed', additions: 4, deletions: 1 };

    // When
    const reason = missingPatchReason(file);

    // Then
    expect(reason).toBe('unavailable');
  });

  it('treats any other patchless file as unavailable', () => {
    // Given
    const file = { status: 'modified', additions: 0, deletions: 0 };

    // When
    const reason = missingPatchReason(file);

    // Then
    expect(reason).toBe('unavailable');
  });
});

describe('positionForNewLine', () => {
  it('counts later hunk headers as positions', () => {
    // Given
    const patch = '@@ -1,3 +1,6 @@\n+B1\n+B2\n+B3\n line 01\n line 02\n A1\n'
      + '@@ -27,7 +30,7 @@ line 21\n line 22\n line 23\n line 24\n-line 25\n+B changed 25\n line 26';

    // When
    const position = positionForNewLine(patch, 33);

    // Then
    expect(position).toBe(12);
  });

  it('counts a mid-hunk no-newline marker as a position', () => {
    // Given
    const patch = '@@ -1,3 +1,4 @@\n x1\n x2\n-x3\n\\ No newline at end of file\n+x3\n+x4';

    // When
    const positions = [positionForNewLine(patch, 3), positionForNewLine(patch, 4)];

    // Then
    expect(positions).toEqual([5, 6]);
  });

  it('returns null for a line outside the patch, or no patch at all', () => {
    // Given
    const patch = '@@ -1,2 +1,2 @@\n a\n-b\n+c';

    // When
    const positions = [positionForNewLine(patch, 9), positionForNewLine(null, 1)];

    // Then
    expect(positions).toEqual([null, null]);
  });
});
