/**
 * Flattens a parsed JSON response into the row list the tree renders.
 *
 * Flattening rather than recursing in JSX is what makes striping by *visible*
 * order straightforward (requirement 2.2.1) and keeps a future virtualisation
 * a drop-in change.
 */

export type RowKind = 'scalar' | 'object' | 'array' | 'empty';

export interface TreeRow {
  /**
   * Structural identity — the parent's id plus the child's *index*, e.g.
   * `0.3.1`. Deliberately not built from property names: a followed link
   * returns arbitrary JSON from any service, and a key containing `.` or `[`
   * would make a name-based path collide with a genuinely nested one, which
   * would toggle unrelated nodes and duplicate React keys.
   */
  id: string;
  depth: number;
  /** Property name, or `[n]` for an array item. */
  label: string;
  kind: RowKind;
  /** Rendered text for a scalar row. */
  value?: string;
  isLink: boolean;
  childCount: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Whether a string is a followable link.
 *
 * Any absolute http(s) URL counts, whatever the property is called — that
 * catches `href`, HAL `_links.<rel>.href` and one-off names like `documentUrl`
 * without maintaining a list of them.
 */
export function isLinkValue(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

/** How a scalar is shown. Strings are shown bare — quotes only add noise. */
export function scalarText(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  return String(value);
}

function kindOf(value: unknown): RowKind {
  if (Array.isArray(value)) return value.length === 0 ? 'empty' : 'array';
  if (isObject(value)) return Object.keys(value).length === 0 ? 'empty' : 'object';
  return 'scalar';
}

/** Children of a container, as [label, value] pairs in document order. */
function childrenOf(value: unknown): Array<[string, unknown]> {
  // Array items are labelled by index alone; the parent row directly above
  // already carries the property name.
  if (Array.isArray(value)) return value.map((item, i) => [`[${i}]`, item]);
  if (isObject(value)) return Object.entries(value);
  return [];
}

/**
 * The visible rows for a value, given the set of expanded row ids.
 *
 * Absence from `expanded` means collapsed, so a response opens with every
 * nested container closed and no traversal is needed to set that up.
 */
export function buildRows(value: unknown, expanded: Set<string>): TreeRow[] {
  const rows: TreeRow[] = [];

  const walk = (entries: Array<[string, unknown]>, depth: number, prefix: string): void => {
    entries.forEach(([label, child], index) => {
      const id = prefix === '' ? String(index) : `${prefix}.${index}`;
      const kind = kindOf(child);
      const children = childrenOf(child);

      rows.push({
        id,
        depth,
        label,
        kind,
        // An empty container shows its literal form inline; it has no collapse
        // control, because a `+` that expands to nothing reads as a bug.
        value: kind === 'scalar' ? scalarText(child)
          : kind === 'empty' ? (Array.isArray(child) ? '[]' : '{}')
            : undefined,
        isLink: kind === 'scalar' && isLinkValue(child),
        childCount: children.length,
      });

      // 'empty' is a leaf: a `+` that expands to nothing reads as a bug.
      if (kind !== 'scalar' && kind !== 'empty' && expanded.has(id)) {
        walk(children, depth + 1, id);
      }
    });
  };

  // A scalar body has no properties of its own, so it becomes a single row.
  if (kindOf(value) === 'scalar') {
    return [{
      id: '0',
      depth: 0,
      label: '',
      kind: 'scalar',
      value: scalarText(value),
      isLink: isLinkValue(value),
      childCount: 0,
    }];
  }

  walk(childrenOf(value), 0, '');
  return rows;
}

/** Every expandable row id, for expand-all. */
export function allExpandableIds(value: unknown): string[] {
  const ids: string[] = [];

  const walk = (entries: Array<[string, unknown]>, prefix: string): void => {
    entries.forEach(([, child], index) => {
      const id = prefix === '' ? String(index) : `${prefix}.${index}`;
      const kind = kindOf(child);
      if (kind === 'scalar' || kind === 'empty') return;
      ids.push(id);
      walk(childrenOf(child), id);
    });
  };

  walk(childrenOf(value), '');
  return ids;
}

// ---------------------------------------------------------------------------
// Body classification
// ---------------------------------------------------------------------------

/**
 * Above this the tree is not built at all.
 *
 * R3's 5 MB cap in `rest.ts` is a *transport* limit and does nothing to
 * protect the renderer: a 2 MB JSON body is tens of thousands of rows.
 */
export const MAX_TREE_BYTES = 1024 * 1024;

export type BodyView =
  | { kind: 'tree'; data: unknown }
  | { kind: 'raw'; notice: string | null }
  | { kind: 'binary'; contentType: string; bytes: number }
  | { kind: 'empty' };

/** Case-insensitive header lookup — servers send whatever casing they like. */
export function headerValue(
  headers: Array<[string, string]>, name: string
): string | null {
  const target = name.toLowerCase();
  const hit = headers.find(([key]) => key.toLowerCase() === target);
  return hit ? hit[1] : null;
}

/** The media type without its parameters, lowercased. */
export function baseMediaType(contentType: string | null): string {
  return (contentType ?? '').split(';')[0].trim().toLowerCase();
}

/**
 * Media-type predicates.
 *
 * Matching is on a substring rather than the `+json` / `+xml` convention: the
 * catalogue publishes `application/vnd.nykredit-v2=xml` with an `=`, which no
 * suffix-based rule would catch.
 */
export function isJsonType(contentType: string | null): boolean {
  return baseMediaType(contentType).includes('json');
}

export function isBinaryType(contentType: string | null): boolean {
  const base = baseMediaType(contentType);
  if (base === '') return false;
  if (base.startsWith('text/')) return false;
  if (base.includes('json') || base.includes('xml')) return false;
  // Everything else that is not obviously text: pdf, octet-stream, images.
  return base.startsWith('application/') || base.startsWith('image/')
    || base.startsWith('audio/') || base.startsWith('video/');
}

/**
 * Decide how a response body should be presented.
 *
 * Binary detection leans on `Content-Type` alone: the body has already been
 * UTF-8 decoded by the time it reaches here, so invalid bytes have become
 * U+FFFD and cannot be told apart from a legitimate replacement character.
 */
export function classifyBody(
  body: string, headers: Array<[string, string]>, truncated: boolean
): BodyView {
  const contentType = headerValue(headers, 'content-type');

  if (body.length === 0) return { kind: 'empty' };

  if (isBinaryType(contentType)) {
    return { kind: 'binary', contentType: baseMediaType(contentType), bytes: body.length };
  }

  if (isJsonType(contentType)) {
    if (body.length > MAX_TREE_BYTES) {
      return {
        kind: 'raw',
        notice: 'Response is too large to display as a tree — showing raw text.',
      };
    }
    try {
      return { kind: 'tree', data: JSON.parse(body) };
    } catch {
      return {
        kind: 'raw',
        notice: truncated
          ? 'Response was truncated, so it is not valid JSON — showing raw text.'
          : 'Response is not valid JSON — showing raw text.',
      };
    }
  }

  return { kind: 'raw', notice: null };
}
