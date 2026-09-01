import { describe, it, expect } from 'vitest';
import {
  MAX_TREE_BYTES, allExpandableIds, baseMediaType, buildRows, classifyBody, headerValue,
  isBinaryType, isJsonType, isLinkValue, scalarText,
} from './responseTree';

const none = new Set<string>();

describe('isLinkValue', () => {
  it('accepts absolute http and https URLs', () => {
    expect(isLinkValue('https://mortgage.services.nykredit.it/consent/consents/1')).toBe(true);
    expect(isLinkValue('http://127.0.0.1:7001/thing')).toBe(true);
  });

  it('rejects anything that is not an absolute http(s) URL', () => {
    expect(isLinkValue('not a url')).toBe(false);
    expect(isLinkValue('/consent/consents/1')).toBe(false);
    expect(isLinkValue('mailto:someone@example.com')).toBe(false);
    expect(isLinkValue('ftp://example.net/x')).toBe(false);
    expect(isLinkValue(42)).toBe(false);
    expect(isLinkValue(null)).toBe(false);
  });

  it('tolerates surrounding whitespace', () => {
    expect(isLinkValue('  https://example.net/a  ')).toBe(true);
  });
});

describe('scalarText', () => {
  it('renders strings bare and other scalars by value', () => {
    expect(scalarText('abc')).toBe('abc');
    expect(scalarText(0)).toBe('0');
    expect(scalarText(false)).toBe('false');
    expect(scalarText(null)).toBe('null');
  });
});

describe('buildRows', () => {
  const body = {
    id: 'abc',
    href: 'https://example.net/consents/abc',
    nested: { field: 'value' },
    loans: [{ id: 'l1' }, { id: 'l2' }],
    empties: [],
    blank: {},
  };

  it('shows the root properties and collapses every container by default', () => {
    const rows = buildRows(body, none);
    expect(rows.map((r) => r.label))
      .toEqual(['id', 'href', 'nested', 'loans', 'empties', 'blank']);
    expect(rows.every((r) => r.depth === 0)).toBe(true);
  });

  it('marks containers and empties by kind', () => {
    const byLabel = Object.fromEntries(buildRows(body, none).map((r) => [r.label, r.kind]));
    expect(byLabel).toMatchObject({
      id: 'scalar', href: 'scalar', nested: 'object',
      loans: 'array', empties: 'empty', blank: 'empty',
    });
  });

  it('flags a link value', () => {
    const href = buildRows(body, none).find((r) => r.label === 'href')!;
    expect(href.isLink).toBe(true);
    expect(buildRows(body, none).find((r) => r.label === 'id')!.isLink).toBe(false);
  });

  it('expands only the requested container', () => {
    const nestedId = buildRows(body, none).find((r) => r.label === 'nested')!.id;
    const rows = buildRows(body, new Set([nestedId]));
    const labels = rows.map((r) => r.label);
    expect(labels).toContain('field');
    // The sibling array stays closed.
    expect(labels).not.toContain('[0]');
    expect(rows.find((r) => r.label === 'field')!.depth).toBe(1);
  });

  it('labels array items by index alone', () => {
    const loansId = buildRows(body, none).find((r) => r.label === 'loans')!.id;
    const labels = buildRows(body, new Set([loansId])).map((r) => r.label);
    expect(labels).toContain('[0]');
    expect(labels).toContain('[1]');
  });

  it('never emits children for an empty container', () => {
    const emptiesId = buildRows(body, none).find((r) => r.label === 'empties')!.id;
    // Even if it is somehow marked expanded, there is nothing to show.
    expect(buildRows(body, new Set([emptiesId]))).toHaveLength(6);
  });

  it('reports child counts so a collapsed row can hint at its size', () => {
    const rows = buildRows(body, none);
    expect(rows.find((r) => r.label === 'loans')!.childCount).toBe(2);
    expect(rows.find((r) => r.label === 'nested')!.childCount).toBe(1);
  });

  it('renders a scalar body as a single row', () => {
    expect(buildRows('just a string', none))
      .toEqual([{ id: '0', depth: 0, label: '', kind: 'scalar', value: 'just a string', isLink: false, childCount: 0 }]);
  });

  it('renders an array body at the root', () => {
    const rows = buildRows([{ a: 1 }, { a: 2 }], none);
    expect(rows.map((r) => r.label)).toEqual(['[0]', '[1]']);
  });
});

describe('buildRows identity', () => {
  it('does not collide when a property name contains dots or brackets', () => {
    // The regression this guards: a name-derived path would make the top-level
    // key "a.b" indistinguishable from the nested route a -> b.
    const body = { 'a.b': 'flat', a: { b: 'nested' }, 'loans[0]': 'trap', loans: [{ x: 1 }] };
    const rows = buildRows(body, none);
    const ids = rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps ids unique across every expanded level', () => {
    const body = { a: { b: { c: 1 } }, d: [{ e: 2 }] };
    const all = new Set(allExpandableIds(body));
    const ids = buildRows(body, all).map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives a stable id to the same node across renders', () => {
    const body = { a: { b: 1 }, c: 2 };
    const first = buildRows(body, none).find((r) => r.label === 'a')!.id;
    const second = buildRows(body, new Set([first])).find((r) => r.label === 'a')!.id;
    expect(second).toBe(first);
  });
});

describe('allExpandableIds', () => {
  it('covers every level, so expand-all reaches the deepest node', () => {
    const body = { a: { b: { c: { d: 1 } } } };
    const ids = allExpandableIds(body);
    expect(ids).toHaveLength(3);
    expect(buildRows(body, new Set(ids)).map((r) => r.label)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('omits scalars and empty containers', () => {
    expect(allExpandableIds({ a: 1, b: [], c: {}, d: null })).toEqual([]);
  });

  it('descends into array items', () => {
    const ids = allExpandableIds({ loans: [{ deep: { x: 1 } }] });
    // loans, loans[0], loans[0].deep
    expect(ids).toHaveLength(3);
  });
});

describe('headerValue', () => {
  it('matches case-insensitively', () => {
    expect(headerValue([['Content-Type', 'application/json']], 'content-type'))
      .toBe('application/json');
    expect(headerValue([['content-type', 'application/json']], 'Content-Type'))
      .toBe('application/json');
  });

  it('returns null when absent', () => {
    expect(headerValue([], 'content-type')).toBeNull();
  });
});

describe('media type predicates', () => {
  it('strips parameters', () => {
    expect(baseMediaType('application/json;v=4')).toBe('application/json');
  });

  it('recognises JSON including the versioned and HAL forms', () => {
    expect(isJsonType('application/json')).toBe(true);
    expect(isJsonType('application/json;v=4')).toBe(true);
    expect(isJsonType('application/hal+json')).toBe(true);
    expect(isJsonType(null)).toBe(false);
  });

  it('treats the catalogue\'s "=xml" typo as non-binary text', () => {
    // Published as `application/vnd.nykredit-v2=xml`, not `+xml`; a suffix
    // rule would misclassify it as binary and hide the body.
    expect(isBinaryType('application/vnd.nykredit-v2=xml')).toBe(false);
    expect(isJsonType('application/vnd.nykredit-v2=xml')).toBe(false);
  });

  it('recognises binary types', () => {
    expect(isBinaryType('application/pdf')).toBe(true);
    expect(isBinaryType('application/octet-stream')).toBe(true);
    expect(isBinaryType('image/png')).toBe(true);
  });

  it('never treats text or an absent type as binary', () => {
    expect(isBinaryType('text/plain')).toBe(false);
    expect(isBinaryType('text/html')).toBe(false);
    expect(isBinaryType('application/json')).toBe(false);
    expect(isBinaryType(null)).toBe(false);
  });
});

describe('classifyBody', () => {
  const json = (t = 'application/json'): Array<[string, string]> => [['content-type', t]];

  it('parses a JSON body into a tree', () => {
    const view = classifyBody('{"a":1}', json(), false);
    expect(view).toEqual({ kind: 'tree', data: { a: 1 } });
  });

  it('falls back to raw text when JSON does not parse', () => {
    const view = classifyBody('<html>gateway error</html>', json(), false);
    expect(view.kind).toBe('raw');
    expect((view as any).notice).toMatch(/not valid JSON/);
  });

  it('explains a parse failure caused by truncation', () => {
    const view = classifyBody('{"a":', json(), true);
    expect((view as any).notice).toMatch(/truncated/);
  });

  it('refuses to build a tree above the render threshold', () => {
    const big = `{"a":"${'x'.repeat(MAX_TREE_BYTES)}"}`;
    const view = classifyBody(big, json(), false);
    expect(view.kind).toBe('raw');
    expect((view as any).notice).toMatch(/too large/);
  });

  it('shows a placeholder for binary rather than dumping bytes', () => {
    const view = classifyBody('%PDF-1.4 ...', [['content-type', 'application/pdf']], false);
    expect(view).toEqual({ kind: 'binary', contentType: 'application/pdf', bytes: 12 });
  });

  it('renders XML and text as raw with no notice', () => {
    expect(classifyBody('<a/>', [['content-type', 'application/atom=xml']], false))
      .toEqual({ kind: 'raw', notice: null });
    expect(classifyBody('hello', [['content-type', 'text/plain']], false))
      .toEqual({ kind: 'raw', notice: null });
  });

  it('reports an empty body explicitly', () => {
    expect(classifyBody('', json(), false)).toEqual({ kind: 'empty' });
    expect(classifyBody('', [], false)).toEqual({ kind: 'empty' });
  });

  it('falls back to raw when the server declares no content type', () => {
    expect(classifyBody('{"a":1}', [], false)).toEqual({ kind: 'raw', notice: null });
  });
});

describe('empty containers render inline', () => {
  it('shows [] for an empty array and {} for an empty object', () => {
    const rows = buildRows({ list: [], map: {} }, none);
    expect(rows.find((r) => r.label === 'list')!.value).toBe('[]');
    expect(rows.find((r) => r.label === 'map')!.value).toBe('{}');
  });
});
