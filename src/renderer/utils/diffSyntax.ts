import { LanguageDescription, LRLanguage } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { NodePropSource, Parser, Tree } from '@lezer/common';
import { highlightTree, styleTags, tagHighlighter, tags } from '@lezer/highlight';
import { DiffHunk, DiffLine } from '../../main/githubDiff';

export type SyntaxKind =
  | 'keyword' | 'string' | 'number' | 'comment' | 'annotation'
  | 'function' | 'constant' | 'property' | 'tag';

export interface SyntaxToken {
  text: string;
  kind: SyntaxKind | null;
}

export type DiffSyntax = Map<DiffLine, SyntaxToken[]>;

export interface DiffParser {
  parser: Parser;
  profile: LanguageProfile;
}

interface LanguageProfile {
  styles?: NodePropSource;
  nodeKinds?: Record<string, SyntaxKind>;
  contexts?: string[];
  blockComments?: boolean;
}

const C_STYLE: LanguageProfile = { blockComments: true };

/*
 * - styles: tags for nodes the grammar leaves untagged.
 * - nodeKinds: kinds keyed by `Parent/Child` node names, applied by walking
 *   the tree. `styleTags` cannot do this: when merged into a grammar it orders
 *   a contextual rule behind the grammar's own rule for the same node.
 * - contexts: openings each hunk is also parsed inside, the one with the
 *   fewest errors winning (ties to the bare fragment). A hunk is a fragment,
 *   and Java only accepts a method declaration inside a class body.
 * - blockComments: a hunk may open part-way through a `/* … *\/` comment. Not
 *   every language: a line opening with `*` is ordinary markdown or SQL.
 */
const PROFILES: Record<string, LanguageProfile> = {
  Java: {
    styles: styleTags({ 'MarkerAnnotation Annotation': tags.annotation }),
    nodeKinds: {
      'MarkerAnnotation/Identifier': 'annotation',
      'Annotation/Identifier': 'annotation',
      'MethodDeclaration/Definition': 'function',
      'ConstructorDeclaration/Definition': 'function',
    },
    contexts: ['class _{', 'class _{void _(){'],
    blockComments: true,
  },
  ...Object.fromEntries([
    'Kotlin', 'Groovy', 'Scala', 'JavaScript', 'TypeScript', 'JSX', 'TSX',
    'C', 'C++', 'C#', 'Go', 'Rust', 'CSS', 'SCSS', 'LESS', 'PHP', 'Swift', 'Dart',
  ].map((name) => [name, C_STYLE])),
};

const VARIABLE = 'variable';

const highlighter = tagHighlighter([
  { tag: [tags.keyword, tags.self, tags.bool, tags.null, tags.standard(tags.typeName)], class: 'keyword' },
  { tag: [tags.string, tags.regexp, tags.escape, tags.attributeValue], class: 'string' },
  { tag: tags.number, class: 'number' },
  { tag: tags.comment, class: 'comment' },
  { tag: tags.annotation, class: 'annotation' },
  { tag: tags.function(tags.definition(tags.variableName)), class: 'function' },
  { tag: tags.constant(tags.variableName), class: 'constant' },
  { tag: tags.propertyName, class: 'property' },
  { tag: tags.tagName, class: 'tag' },
  { tag: tags.variableName, class: VARIABLE },
]);

const BLOCK_COMMENT_OPEN = '/*';

const CONSTANT_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;

const loaded = new Map<string, DiffParser | null>();
const loading = new Map<string, Promise<DiffParser | null>>();

function describe(path: string): LanguageDescription | null {
  return LanguageDescription.matchFilename(languages, path.slice(path.lastIndexOf('/') + 1));
}

export function peekDiffParser(path: string): DiffParser | null | undefined {
  const description = describe(path);
  if (!description) return null;
  return loaded.has(description.name) ? loaded.get(description.name) : undefined;
}

export function loadDiffParser(path: string): Promise<DiffParser | null> {
  const description = describe(path);
  if (!description) return Promise.resolve(null);
  const { name } = description;
  const profile = PROFILES[name] ?? {};
  const pending = loading.get(name) ?? description.load()
    .then(({ language }): DiffParser => ({
      parser: profile.styles && language instanceof LRLanguage
        ? language.configure({ props: [profile.styles] }).parser
        : language.parser,
      profile,
    }))
    .catch((err: unknown) => {
      console.warn(`[diffSyntax] Could not load ${name} highlighting:`, err);
      return null;
    })
    .then((result) => {
      loaded.set(name, result);
      return result;
    });
  loading.set(name, pending);
  return pending;
}

function opensInsideBlockComment(lines: DiffLine[]): boolean {
  const first = lines.find((line) => line.content.trim() !== '');
  if (!first || !first.content.trimStart().startsWith('*')) return false;
  const source = lines.map((line) => line.content).join('\n');
  const close = source.indexOf('*/');
  if (close < 0) {
    return lines.every((line) => line.content.trim() === '' || line.content.trimStart().startsWith('*'));
  }
  const open = source.indexOf(BLOCK_COMMENT_OPEN);
  return open < 0 || close < open;
}

interface ParsedSide {
  source: string;
  tree: Tree;
  start: number;
}

function errorsBefore(tree: Tree, end: number): number {
  let errors = 0;
  tree.iterate({
    enter: (node) => {
      if (node.type.isError && node.from < end) errors += 1;
    },
  });
  return errors;
}

function parseInBestContext(parser: Parser, contexts: string[], text: string): ParsedSide {
  const contentEnd = text.trimEnd().length;
  let best: ParsedSide = { source: text, tree: parser.parse(text), start: 0 };
  let bestErrors = errorsBefore(best.tree, contentEnd);
  for (const context of contexts) {
    if (bestErrors === 0) break;
    const source = context + text;
    const tree = parser.parse(source);
    const errors = errorsBefore(tree, context.length + contentEnd);
    if (errors < bestErrors) {
      best = { source, tree, start: context.length };
      bestErrors = errors;
    }
  }
  return best;
}

function contextualKinds(tree: Tree, nodeKinds: Record<string, SyntaxKind> | undefined): Map<number, SyntaxKind> {
  const kinds = new Map<number, SyntaxKind>();
  if (!nodeKinds) return kinds;
  const path: string[] = [];
  tree.iterate({
    enter: (node) => {
      const kind = nodeKinds[`${path[path.length - 1]}/${node.name}`];
      if (kind) kinds.set(node.from, kind);
      path.push(node.name);
    },
    leave: () => {
      path.pop();
    },
  });
  return kinds;
}

function kindOf(classes: string, text: string): SyntaxKind | null {
  const kind = classes.slice(classes.lastIndexOf(' ') + 1);
  if (kind !== VARIABLE) return kind as SyntaxKind;
  return text.length > 1 && CONSTANT_NAME.test(text) ? 'constant' : null;
}

function pushToken(tokens: SyntaxToken[], text: string, kind: SyntaxKind | null): void {
  if (!text) return;
  const last = tokens[tokens.length - 1];
  if (last && last.kind === kind) last.text += text;
  else tokens.push({ text, kind });
}

interface Span {
  from: number;
  to: number;
  kind: SyntaxKind | null;
}

function highlightSide(lines: DiffLine[], { parser, profile }: DiffParser, out: DiffSyntax): void {
  if (lines.length === 0) return;
  const opening = profile.blockComments && opensInsideBlockComment(lines) ? BLOCK_COMMENT_OPEN : '';
  const text = opening + lines.map((line) => line.content).join('\n');
  const { source, tree, start } = parseInBestContext(parser, profile.contexts ?? [], text);
  const overrides = contextualKinds(tree, profile.nodeKinds);

  const spans: Span[] = [];
  highlightTree(tree, highlighter, (from, to, classes) => {
    spans.push({ from, to, kind: overrides.get(from) ?? kindOf(classes, source.slice(from, to)) });
  });

  let spanIndex = 0;
  let lineStart = start + opening.length;
  for (const line of lines) {
    const lineEnd = lineStart + line.content.length;
    const tokens: SyntaxToken[] = [];
    let pos = lineStart;
    while (spanIndex < spans.length && spans[spanIndex].from < lineEnd) {
      const span = spans[spanIndex];
      const from = Math.max(span.from, lineStart);
      const to = Math.min(span.to, lineEnd);
      if (from > pos) pushToken(tokens, source.slice(pos, from), null);
      if (to > from) pushToken(tokens, source.slice(from, to), span.kind);
      pos = Math.max(pos, to);
      if (span.to > lineEnd) break;
      spanIndex += 1;
    }
    pushToken(tokens, source.slice(pos, lineEnd), null);
    out.set(line, tokens);
    lineStart = lineEnd + 1;
  }
}

export function highlightDiff(hunks: DiffHunk[], diffParser: DiffParser): DiffSyntax {
  const out: DiffSyntax = new Map();
  for (const hunk of hunks) {
    highlightSide(hunk.lines.filter((line) => line.kind !== 'add'), diffParser, out);
    highlightSide(hunk.lines.filter((line) => line.kind !== 'del'), diffParser, out);
  }
  return out;
}
