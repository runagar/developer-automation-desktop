import { beforeAll, describe, expect, it } from 'vitest';
import { DiffLine, parsePatch } from '../../main/githubDiff';
import { DiffParser, DiffSyntax, highlightDiff, loadDiffParser, peekDiffParser } from './diffSyntax';

let java: DiffParser;

beforeAll(async () => {
  java = (await loadDiffParser('src/Foo.java'))!;
});

function highlight(patch: string, parser: DiffParser = java): { lines: DiffLine[]; syntax: DiffSyntax } {
  const { hunks } = parsePatch(patch);
  return { lines: hunks.flatMap((h) => h.lines), syntax: highlightDiff(hunks, parser) };
}

function coloured(syntax: DiffSyntax, line: DiffLine): string[] {
  return (syntax.get(line) ?? []).filter((t) => t.kind).map((t) => `${t.kind}:${t.text}`);
}

describe('highlightDiff', () => {
  it('colours Java syntax the way the IDE does and keeps every character', () => {
    // Given
    const patch = [
      '@@ -1,2 +1,5 @@',
      ' @Inject',
      '+private static final int DEFAULT_BATCH_SIZE = 1000;',
      '+public void load(String id) {',
      '+    return parse("x" + id, DEFAULT_BATCH_SIZE); // go',
      ' }',
    ].join('\n');

    // When
    const { lines, syntax } = highlight(patch);

    // Then
    expect(coloured(syntax, lines[0])).toEqual(['annotation:@Inject']);
    expect(coloured(syntax, lines[1])).toEqual([
      'keyword:private', 'keyword:static', 'keyword:final', 'keyword:int', 'constant:DEFAULT_BATCH_SIZE', 'number:1000',
    ]);
    expect(coloured(syntax, lines[2])).toEqual(['keyword:public', 'keyword:void', 'function:load']);
    expect(coloured(syntax, lines[3])).toEqual([
      'keyword:return', 'string:"x"', 'constant:DEFAULT_BATCH_SIZE', 'comment:// go',
    ]);
    for (const line of lines) {
      expect((syntax.get(line) ?? []).map((t) => t.text).join('')).toBe(line.content);
    }
  });

  it('highlights deletions from the old file and context from the new one', () => {
    // Given
    const patch = ['@@ -1,3 +1,1 @@', '-/*', ' int x = 1;', '-*/'].join('\n');

    // When
    const { lines, syntax } = highlight(patch);

    // Then
    expect(coloured(syntax, lines[0])).toEqual(['comment:/*']);
    expect(coloured(syntax, lines[1])).toEqual(['keyword:int', 'number:1']);
    expect(coloured(syntax, lines[2])).toEqual(['comment:*/']);
  });

  it('treats a hunk that opens mid-javadoc as comment until it closes', () => {
    // Given
    const patch = ['@@ -10,3 +10,3 @@', '  * Loads things.', '  */', '-void load() {', '+void fetch() {'].join('\n');

    // When
    const { lines, syntax } = highlight(patch);

    // Then
    expect(coloured(syntax, lines[0])).toEqual(['comment: * Loads things.']);
    expect(coloured(syntax, lines[1])).toEqual(['comment: */']);
    expect(coloured(syntax, lines[3])).toEqual(['keyword:void', 'function:fetch']);
  });

  it('does not let a comment left open in one hunk swallow the next', () => {
    // Given
    const patch = ['@@ -1,1 +1,1 @@', ' /**', '@@ -20,1 +20,1 @@', ' return 1;'].join('\n');

    // When
    const { lines, syntax } = highlight(patch);

    // Then
    expect(coloured(syntax, lines[1])).toEqual(['keyword:return', 'number:1']);
  });

  it('reads a leading * as markup, not a comment, outside C-style languages', async () => {
    // Given
    const markdown = (await loadDiffParser('docs/README.md'))!;
    const patch = ['@@ -1,2 +1,2 @@', ' * item', ' */'].join('\n');

    // When
    const { lines, syntax } = highlight(patch, markdown);

    // Then
    expect(coloured(syntax, lines[0])).not.toContain('comment:* item');
  });
});

describe('peekDiffParser', () => {
  it('reports a language as pending until loaded, and a file with no grammar as plain', async () => {
    // Given
    const path = 'deploy/run.py';

    // When
    const before = peekDiffParser(path);
    await loadDiffParser(path);

    // Then
    expect(before).toBeUndefined();
    expect(peekDiffParser(path)).not.toBeFalsy();
    expect(peekDiffParser('notes.unknownext')).toBeNull();
  });
});
