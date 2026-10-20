/**
 * Group flat paths into a directory tree.
 *
 * Pure and generic over the payload so it can be unit tested without React or
 * any GitHub type.
 */

export interface FileTreeDir<T> {
  kind: 'dir';
  /** Display name; a compressed chain renders as `a/b/c`. */
  name: string;
  /** Full path of the deepest directory in the chain, unique per node. */
  path: string;
  children: FileTreeNode<T>[];
}

export interface FileTreeFile<T> {
  kind: 'file';
  /** Base name including extension — the only part worth reading in a list. */
  name: string;
  path: string;
  item: T;
}

export type FileTreeNode<T> = FileTreeDir<T> | FileTreeFile<T>;

interface Building<T> {
  dirs: Map<string, Building<T>>;
  files: { name: string; path: string; item: T }[];
}

function emptyNode<T>(): Building<T> {
  return { dirs: new Map(), files: [] };
}

/**
 * Build a tree from items carrying a `/`-separated path.
 *
 * Directories with exactly one child directory and no files of their own are
 * **compressed** into a single row (`src/main/java/dk`), because a deep
 * package path otherwise costs one row and one indent level per segment and
 * pushes the file names off a narrow panel.
 */
export function buildFileTree<T extends { path: string }>(items: T[]): FileTreeNode<T>[] {
  const root = emptyNode<T>();

  for (const item of items) {
    // A leading slash or a doubled separator must not create a blank level.
    const segments = item.path.split('/').filter(Boolean);
    if (segments.length === 0) continue;

    const fileName = segments[segments.length - 1];
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      let next = node.dirs.get(segment);
      if (!next) {
        next = emptyNode<T>();
        node.dirs.set(segment, next);
      }
      node = next;
    }
    node.files.push({ name: fileName, path: item.path, item });
  }

  return toNodes(root, '');
}

function toNodes<T>(node: Building<T>, prefix: string): FileTreeNode<T>[] {
  const dirs: FileTreeDir<T>[] = [];

  for (const [name, child] of node.dirs) {
    let displayName = name;
    let path = prefix ? `${prefix}/${name}` : name;
    let current = child;

    // Compress a chain of single directories into one row.
    while (current.files.length === 0 && current.dirs.size === 1) {
      const [onlyName, onlyChild] = [...current.dirs.entries()][0];
      displayName = `${displayName}/${onlyName}`;
      path = `${path}/${onlyName}`;
      current = onlyChild;
    }

    dirs.push({ kind: 'dir', name: displayName, path, children: toNodes(current, path) });
  }

  // Directories first, then files, each alphabetical — the ordering every file
  // browser uses, so the list is scannable without reading every row.
  dirs.sort((a, b) => a.name.localeCompare(b.name));

  const files: FileTreeFile<T>[] = node.files
    .map((f) => ({ kind: 'file' as const, name: f.name, path: f.path, item: f.item }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return [...dirs, ...files];
}

export interface FlatFileRow<T> {
  node: FileTreeNode<T>;
  depth: number;
}

/**
 * Flatten to the rows actually on screen, in order.
 *
 * Rendering from a flat list rather than recursively is what lets striping
 * follow *visible* order, so the alternation stays correct as folders are
 * collapsed and expanded — the same approach `ResponseTree` uses.
 */
export function flattenVisible<T>(
  nodes: FileTreeNode<T>[], collapsed: ReadonlySet<string>, depth = 0
): FlatFileRow<T>[] {
  const rows: FlatFileRow<T>[] = [];
  for (const node of nodes) {
    rows.push({ node, depth });
    if (node.kind === 'dir' && !collapsed.has(node.path)) {
      rows.push(...flattenVisible(node.children, collapsed, depth + 1));
    }
  }
  return rows;
}

/** Every directory path in the tree, for expand-all / collapse-all. */
export function allDirPaths<T>(nodes: FileTreeNode<T>[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (node.kind !== 'dir') continue;
    out.push(node.path);
    out.push(...allDirPaths(node.children));
  }
  return out;
}

/** Every directory path holding at least one matching file, at any depth beneath it. */
export function dirPathsContaining<T>(nodes: FileTreeNode<T>[], matches: (item: T) => boolean): Set<string> {
  const out = new Set<string>();
  const visit = (list: FileTreeNode<T>[]): boolean => list.reduce((found, node) => {
    if (node.kind === 'file') return matches(node.item) || found;
    const inside = visit(node.children);
    if (inside) out.add(node.path);
    return inside || found;
  }, false);
  visit(nodes);
  return out;
}

/**
 * The first matching file after `currentPath` in the tree's display order,
 * wrapping round to the top; never `currentPath` itself.
 */
export function nextFileAfter<T>(
  nodes: FileTreeNode<T>[], currentPath: string | null, matches: (item: T) => boolean
): string | null {
  const files = flattenVisible(nodes, new Set()).flatMap(({ node }) => (node.kind === 'file' ? [node] : []));
  const current = files.findIndex((file) => file.path === currentPath);
  const ordered = current < 0 ? files : [...files.slice(current + 1), ...files.slice(0, current)];
  return ordered.find((file) => matches(file.item))?.path ?? null;
}
