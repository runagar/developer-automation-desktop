import { describe, it, expect } from 'vitest';
import { FileTreeDir, allDirPaths, buildFileTree, flattenVisible } from './fileTree';

const f = (path: string): { path: string } => ({ path });

function shape(nodes: ReturnType<typeof buildFileTree<{ path: string }>>): string[] {
  const out: string[] = [];
  const walk = (list: typeof nodes, depth: number): void => {
    for (const node of list) {
      out.push(`${'  '.repeat(depth)}${node.kind === 'dir' ? `${node.name}/` : node.name}`);
      if (node.kind === 'dir') walk(node.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return out;
}

describe('buildFileTree', () => {
  it('nests files under their directories', () => {
    expect(shape(buildFileTree([f('src/a.ts'), f('src/b.ts'), f('README.md')]))).toEqual([
      'src/',
      '  a.ts',
      '  b.ts',
      'README.md',
    ]);
  });

  it('puts directories before files, each alphabetical', () => {
    expect(shape(buildFileTree([f('z.ts'), f('a.ts'), f('b/x.ts'), f('a/y.ts')]))).toEqual([
      'a/', '  y.ts',
      'b/', '  x.ts',
      'a.ts',
      'z.ts',
    ]);
  });

  it('compresses a chain of single directories into one row', () => {
    // A Java package path otherwise costs one row and one indent level per
    // segment and pushes the file name off a narrow panel.
    expect(shape(buildFileTree([f('src/main/java/dk/nykredit/Foo.java')]))).toEqual([
      'src/main/java/dk/nykredit/',
      '  Foo.java',
    ]);
  });

  it('stops compressing where the tree actually branches', () => {
    expect(shape(buildFileTree([
      f('src/main/java/A.java'),
      f('src/test/java/B.java'),
    ]))).toEqual([
      'src/',
      '  main/java/',
      '    A.java',
      '  test/java/',
      '    B.java',
    ]);
  });

  it('does not compress past a directory that holds files of its own', () => {
    expect(shape(buildFileTree([f('src/index.ts'), f('src/lib/util.ts')]))).toEqual([
      'src/',
      '  lib/',
      '    util.ts',
      '  index.ts',
    ]);
  });

  it('keeps the full path on a file while displaying only its base name', () => {
    const [dir] = buildFileTree([f('a/b/c.ts')]) as FileTreeDir<{ path: string }>[];
    expect(dir.path).toBe('a/b');
    expect(dir.children[0]).toMatchObject({ kind: 'file', name: 'c.ts', path: 'a/b/c.ts' });
  });

  it('gives compressed chains a unique path so two chains cannot collide', () => {
    const nodes = buildFileTree([f('x/a/f.ts'), f('y/a/g.ts')]) as FileTreeDir<{ path: string }>[];
    expect(nodes.map((n) => n.path)).toEqual(['x/a', 'y/a']);
  });

  it('ignores empty segments rather than creating blank levels', () => {
    expect(shape(buildFileTree([f('/src//a.ts')]))).toEqual(['src/', '  a.ts']);
  });

  it('skips a pathless entry instead of throwing', () => {
    expect(buildFileTree([f(''), f('a.ts')])).toHaveLength(1);
  });

  it('handles a root-only list', () => {
    expect(shape(buildFileTree([f('a.ts'), f('b.ts')]))).toEqual(['a.ts', 'b.ts']);
  });

  it('carries the original item through', () => {
    const item = { path: 'a/b.ts', additions: 3 };
    const [dir] = buildFileTree([item]) as FileTreeDir<typeof item>[];
    expect(dir.children[0].kind === 'file' && dir.children[0].item.additions).toBe(3);
  });
});

describe('allDirPaths', () => {
  it('lists every directory, including nested ones', () => {
    const tree = buildFileTree([f('src/main/A.java'), f('src/test/B.java'), f('docs/x.md')]);
    expect(allDirPaths(tree).sort()).toEqual(['docs', 'src', 'src/main', 'src/test']);
  });

  it('returns nothing for a flat list', () => {
    expect(allDirPaths(buildFileTree([f('a.ts')]))).toEqual([]);
  });
});

describe('flattenVisible', () => {
  const tree = buildFileTree([f('src/a.ts'), f('src/b.ts'), f('docs/x.md'), f('root.ts')]);

  it('returns rows in visible order with their depth', () => {
    expect(flattenVisible(tree, new Set()).map((r) => `${r.depth}:${r.node.name}`)).toEqual([
      '0:docs', '1:x.md', '0:src', '1:a.ts', '1:b.ts', '0:root.ts',
    ]);
  });

  it('omits the children of a collapsed directory', () => {
    // Striping follows this list, so a collapsed folder must not leave a gap
    // in the alternation.
    expect(flattenVisible(tree, new Set(['src'])).map((r) => r.node.name)).toEqual([
      'docs', 'x.md', 'src', 'root.ts',
    ]);
  });

  it('collapses every level independently', () => {
    const deep = buildFileTree([f('a/b/c.ts'), f('a/d.ts')]);
    expect(flattenVisible(deep, new Set(['a'])).map((r) => r.node.name)).toEqual(['a']);
    expect(flattenVisible(deep, new Set(['a/b'])).map((r) => r.node.name)).toEqual(['a', 'b', 'd.ts']);
  });

  it('returns nothing for an empty tree', () => {
    expect(flattenVisible([], new Set())).toEqual([]);
  });
});
