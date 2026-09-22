/**
 * Unified-patch parsing.
 *
 * Pure: no `fs`, no `electron`, no network, so it is testable under plain
 * vitest — the `vaultFreshness.ts` / `restSchema.ts` precedent.
 *
 * Three separate features read this module's output, which is why it is
 * parsed once here rather than inferred from the DOM:
 *   - the unified diff view,
 *   - the side-by-side pairing,
 *   - comment anchoring, which must produce a `line`/`side` pair GitHub will
 *     accept. GitHub rejects a bad anchor with an unhelpful error, so the
 *     anchor is computed from parsed structure, never from a row index.
 */

export type DiffLineKind = 'add' | 'del' | 'context';
export type DiffSide = 'LEFT' | 'RIGHT';

export interface DiffLine {
  kind: DiffLineKind;
  /** Line number on the left (pre-image). Null for an added line. */
  oldLine: number | null;
  /** Line number on the right (post-image). Null for a deleted line. */
  newLine: number | null;
  /** Text without the leading +/-/space marker. */
  content: string;
  /** True when this line carries `\ No newline at end of file`. */
  noNewline: boolean;
}

export interface DiffHunk {
  /** The `@@ ... @@` line, including any trailing section heading. */
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface ParsedDiff {
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

/**
 * Hunk header grammar.
 *
 * The counts are optional: `@@ -1 +1 @@` is legal and means one line. Treating
 * a missing count as zero rather than one desynchronises every subsequent line
 * number in the file.
 */
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

export function parsePatch(patch: string | null | undefined): ParsedDiff {
  const result: ParsedDiff = { hunks: [], additions: 0, deletions: 0 };
  if (!patch) return result;

  let hunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of patch.split('\n')) {
    const match = HUNK_RE.exec(raw);
    if (match) {
      hunk = {
        header: raw,
        oldStart: Number(match[1]),
        oldCount: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newCount: match[4] === undefined ? 1 : Number(match[4]),
        lines: [],
      };
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
      result.hunks.push(hunk);
      continue;
    }

    if (!hunk) continue; // preamble (`diff --git`, `index`, `---`, `+++`)

    // "\ No newline at end of file" annotates the line before it rather than
    // being a line of its own.
    if (raw.startsWith('\\')) {
      const last = hunk.lines[hunk.lines.length - 1];
      if (last) last.noNewline = true;
      continue;
    }

    const marker = raw[0] ?? ' ';
    const content = raw.length > 0 ? raw.slice(1) : '';

    if (marker === '+') {
      hunk.lines.push({ kind: 'add', oldLine: null, newLine, content, noNewline: false });
      newLine += 1;
      result.additions += 1;
    } else if (marker === '-') {
      hunk.lines.push({ kind: 'del', oldLine, newLine: null, content, noNewline: false });
      oldLine += 1;
      result.deletions += 1;
    } else {
      hunk.lines.push({ kind: 'context', oldLine, newLine, content, noNewline: false });
      oldLine += 1;
      newLine += 1;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Side-by-side pairing
// ---------------------------------------------------------------------------

export interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

/**
 * Pair a hunk's lines into side-by-side rows.
 *
 * A run of deletions immediately followed by a run of additions is the same
 * edit shown twice, so the runs are zipped rather than stacked; the longer run
 * spills into rows with one side empty.
 */
export function toSplitRows(hunk: DiffHunk): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;

  while (i < hunk.lines.length) {
    const line = hunk.lines[i];

    if (line.kind === 'context') {
      rows.push({ left: line, right: line });
      i += 1;
      continue;
    }

    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < hunk.lines.length && hunk.lines[i].kind === 'del') dels.push(hunk.lines[i++]);
    while (i < hunk.lines.length && hunk.lines[i].kind === 'add') adds.push(hunk.lines[i++]);

    const pairs = Math.max(dels.length, adds.length);
    for (let p = 0; p < pairs; p++) {
      rows.push({ left: dels[p] ?? null, right: adds[p] ?? null });
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Comment anchoring
// ---------------------------------------------------------------------------

export interface LineAnchor {
  line: number;
  side: DiffSide;
}

/**
 * The anchor for a single line.
 *
 * A deleted line anchors on `LEFT` at its pre-image number; everything else
 * anchors on `RIGHT` at its post-image number. Commenting on a deleted line is
 * explicitly supported (ambiguity 29).
 */
export function anchorForLine(line: DiffLine): LineAnchor | null {
  if (line.kind === 'del') {
    return line.oldLine === null ? null : { line: line.oldLine, side: 'LEFT' };
  }
  return line.newLine === null ? null : { line: line.newLine, side: 'RIGHT' };
}

export interface MultiLineAnchor {
  line: number;
  side: DiffSide;
  startLine: number;
  startSide: DiffSide;
}

/**
 * The anchor for a multi-line selection, or null when the selection is not
 * one GitHub will accept.
 *
 * The selection is clamped to a single hunk and a single side (ambiguity 29).
 * GitHub rejects the alternatives anyway, and doing it here — in tested, pure
 * code — means the UI cannot produce an invalid anchor by accident.
 */
export function anchorForSelection(hunk: DiffHunk, fromIndex: number, toIndex: number): MultiLineAnchor | null {
  const lo = Math.min(fromIndex, toIndex);
  const hi = Math.max(fromIndex, toIndex);
  if (lo < 0 || hi >= hunk.lines.length) return null;

  const selected = hunk.lines.slice(lo, hi + 1);
  if (selected.length === 0) return null;

  const anchors: LineAnchor[] = [];
  for (const line of selected) {
    const anchor = anchorForLine(line);
    if (!anchor) return null;
    anchors.push(anchor);
  }

  // A context line is addressable from either side, so it must not by itself
  // decide the side of a selection that also contains real changes.
  const changedSides = new Set(
    selected
      .map((line, idx) => (line.kind === 'context' ? null : anchors[idx].side))
      .filter((s): s is DiffSide => s !== null)
  );
  if (changedSides.size > 1) return null;

  const side: DiffSide = changedSides.size === 1 ? [...changedSides][0] : 'RIGHT';

  // Re-derive every number on the chosen side; a context line inside a LEFT
  // selection must contribute its *old* number, not its new one.
  const numbers: number[] = [];
  for (const line of selected) {
    const n = side === 'LEFT' ? line.oldLine : line.newLine;
    if (n === null) return null;
    numbers.push(n);
  }

  const startLine = Math.min(...numbers);
  const endLine = Math.max(...numbers);
  if (startLine === endLine) return null; // single line — use anchorForLine

  return { line: endLine, side, startLine, startSide: side };
}

/** Index of the hunk containing a line, or -1. Used to enforce the clamp. */
export function hunkIndexOfLine(parsed: ParsedDiff, hunk: DiffHunk): number {
  return parsed.hunks.indexOf(hunk);
}

// ---------------------------------------------------------------------------
// Thread placement
// ---------------------------------------------------------------------------

/**
 * Whether a thread anchored at `{line, side}` belongs after a given diff line.
 *
 * Threads render inline in full-PR mode only (ambiguity 28); this is the
 * predicate that decides where.
 */
export function lineMatchesAnchor(line: DiffLine, anchor: LineAnchor): boolean {
  if (anchor.side === 'LEFT') return line.oldLine === anchor.line && line.kind !== 'add';
  return line.newLine === anchor.line && line.kind !== 'del';
}
