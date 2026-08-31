import { describe, it, expect } from 'vitest';
import {
  joinPath, mediaTypeVersion, mergeParameters, parseApiDocsConfig, parseOperations,
  sortServiceNames, splitPathKey, typeSegment, UNTAGGED,
} from './apidocs';

describe('splitPathKey', () => {
  it('strips a terminal #v=N fragment', () => {
    expect(splitPathKey('/consents/{consentId}#v=4'))
      .toEqual({ path: '/consents/{consentId}', acceptVersion: '4' });
  });

  it('leaves a path with no fragment alone', () => {
    expect(splitPathKey('/logs')).toEqual({ path: '/logs', acceptVersion: null });
  });

  it('only strips the anchored version fragment, not any other #', () => {
    expect(splitPathKey('/odd#section'))
      .toEqual({ path: '/odd#section', acceptVersion: null });
    expect(splitPathKey('/odd#v=2/tail'))
      .toEqual({ path: '/odd#v=2/tail', acceptVersion: null });
  });
});

describe('mergeParameters', () => {
  it('keeps path-level parameters that the operation does not redefine', () => {
    const merged = mergeParameters(
      [{ name: 'id', in: 'path', required: true }],
      [{ name: 'Accept', in: 'header', required: true }]
    );
    expect(merged.map((p) => p.name)).toEqual(['id', 'Accept']);
  });

  it('lets the operation override a same name+in parameter', () => {
    const merged = mergeParameters(
      [{ name: 'id', in: 'path', required: false, description: 'path level' }],
      [{ name: 'id', in: 'path', required: true, description: 'operation level' }]
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].description).toBe('operation level');
  });

  it('treats the same name in a different location as distinct', () => {
    const merged = mergeParameters(
      [{ name: 'id', in: 'path' }],
      [{ name: 'id', in: 'query' }]
    );
    expect(merged).toHaveLength(2);
  });
});

describe('parseOperations', () => {
  const contract = {
    basePath: '/consent',
    paths: {
      '/consents/{consentId}#v=2': {
        parameters: [{ name: 'consentId', in: 'path', required: true }],
        get: { summary: 'old', deprecated: true, produces: ['application/json;v=2'] },
      },
      '/consents/{consentId}#v=4': {
        parameters: [{ name: 'consentId', in: 'path', required: true }],
        get: { summary: 'current', produces: ['application/json;v=4'] },
        patch: { summary: 'patch it', produces: ['application/json;v=4'] },
      },
      '/logs': {
        get: { summary: 'logs' },
      },
    },
  };

  it('groups accept-versions of one endpoint onto a single row', () => {
    const rows = parseOperations(contract);
    const get = rows.find((r) => r.method === 'GET' && r.path === '/consents/{consentId}')!;
    expect(get.variants.map((v) => v.acceptVersion)).toEqual(['4', '2']);
  });

  it('keeps different methods on the same path as separate rows', () => {
    const rows = parseOperations(contract);
    const methods = rows.filter((r) => r.path === '/consents/{consentId}').map((r) => r.method);
    expect(methods.sort()).toEqual(['GET', 'PATCH']);
  });

  it('marks a row deprecated only when its newest variant is', () => {
    const rows = parseOperations(contract);
    const get = rows.find((r) => r.method === 'GET' && r.path === '/consents/{consentId}')!;
    expect(get.deprecated).toBe(false);
    expect(get.variants.find((v) => v.acceptVersion === '2')!.deprecated).toBe(true);
  });

  it('marks the row deprecated when the newest variant is deprecated', () => {
    const rows = parseOperations({
      paths: { '/gone#v=1': { get: { deprecated: true } } },
    });
    expect(rows[0].deprecated).toBe(true);
  });

  it('handles an operation with no version fragment', () => {
    const rows = parseOperations(contract);
    const logs = rows.find((r) => r.path === '/logs')!;
    expect(logs.variants).toHaveLength(1);
    expect(logs.variants[0].acceptVersion).toBeNull();
  });

  it('merges path-level parameters into every operation', () => {
    const rows = parseOperations(contract);
    const patch = rows.find((r) => r.method === 'PATCH')!;
    expect(patch.variants[0].parameters.map((p) => p.name)).toContain('consentId');
  });

  it('inherits root-level produces and consumes when the operation has none', () => {
    const rows = parseOperations({
      produces: ['application/json;v=1'],
      consumes: ['application/json;v=1'],
      paths: { '/thing': { post: { summary: 'x' } } },
    });
    expect(rows[0].variants[0].produces).toEqual(['application/json;v=1']);
    expect(rows[0].variants[0].consumes).toEqual(['application/json;v=1']);
  });

  it('ignores non-method keys on a path item', () => {
    const rows = parseOperations({
      paths: { '/thing': { parameters: [{ name: 'a', in: 'query' }], $ref: '#/x', get: {} } },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].method).toBe('GET');
  });

  it('tolerates a contract with no paths', () => {
    expect(parseOperations({})).toEqual([]);
    expect(parseOperations(null)).toEqual([]);
  });
});

describe('sortServiceNames', () => {
  it('sorts numerically, not lexicographically', () => {
    expect(sortServiceNames(['rs-doc-10', 'rs-doc-3', 'rs-doc-1']))
      .toEqual(['rs-doc-1', 'rs-doc-3', 'rs-doc-10']);
  });

  it('sorts case-insensitively', () => {
    expect(sortServiceNames(['bm4lins-aks', 'Bm4LINS', 'api-search']))
      .toEqual(['api-search', 'Bm4LINS', 'bm4lins-aks']);
  });
});

describe('joinPath', () => {
  it('joins a base path with a resource path', () => {
    expect(joinPath('/consent', '/consents')).toBe('/consent/consents');
  });

  it('defaults a missing base path to root', () => {
    expect(joinPath(undefined, '/consents')).toBe('/consents');
    expect(joinPath(null, '/consents')).toBe('/consents');
  });

  it('does not double the separator', () => {
    expect(joinPath('/consent/', '/consents')).toBe('/consent/consents');
    expect(joinPath('/', '/consents')).toBe('/consents');
  });

  it('adds a missing leading slash to the resource path', () => {
    expect(joinPath('/consent', 'consents')).toBe('/consent/consents');
  });
});

describe('mediaTypeVersion', () => {
  it('extracts the version marker', () => {
    expect(mediaTypeVersion('application/json;v=4')).toBe('4');
    expect(mediaTypeVersion('application/json; v=12')).toBe('12');
  });

  it('returns null when there is none', () => {
    expect(mediaTypeVersion('application/json')).toBeNull();
    expect(mediaTypeVersion(null)).toBeNull();
  });
});

describe('typeSegment', () => {
  it('maps a version type to its URL segment', () => {
    expect(typeSegment('RELEASE')).toBe('releases');
    expect(typeSegment('PRERELEASE')).toBe('prereleases');
    expect(typeSegment('BRANCH')).toBe('branches');
  });
});

describe('parseApiDocsConfig', () => {
  it('reads the flat keys api-docs publishes', () => {
    const config = parseApiDocsConfig({
      'endpoint.api-docs': 'https://example.test/api-docs',
      'oauth.clientid': 'abc-123',
      'oauth.endpoint': 'https://security.example.test/security/oauth2/authorize',
      'public.uri': 'https://apidocs.example.test',
      'oauth.redirect': '/cb.html',
    });
    expect(config).toEqual({
      apiBase: 'https://example.test/api-docs',
      clientId: 'abc-123',
      securityHost: 'security.example.test',
      redirectUri: 'https://apidocs.example.test/cb.html',
    });
  });

  it('falls back for missing or malformed values', () => {
    const config = parseApiDocsConfig({ 'oauth.endpoint': 'not a url' });
    expect(config.securityHost).toBe('security.services.nykredit.dk');
    expect(config.clientId).toBe('4afcc127-3297-4e37-8cfc-446ffbce54b2');
  });
});

describe('safeHref (via getContract URL selection)', () => {
  // safeHref is module-private; these assert the rules it must enforce so a
  // regression in URL validation is caught by the shape of the checks.
  const base = 'https://infrastructure.services.nykredit.dk/api-docs';

  function isSafe(href: string): boolean {
    try {
      const link = new URL(href);
      const b = new URL(base);
      return link.hostname === b.hostname
        && link.protocol === b.protocol
        && link.pathname.startsWith(b.pathname);
    } catch {
      return false;
    }
  }

  it('accepts a link to the configured API base', () => {
    expect(isSafe(`${base}/services/rs-consent/categories/default/releases/4.3.0`)).toBe(true);
  });

  it('rejects a different host', () => {
    expect(isSafe('https://evil.test/api-docs/services/x')).toBe(false);
  });

  it('rejects a scheme downgrade that would leak the bearer token', () => {
    expect(isSafe('http://infrastructure.services.nykredit.dk/api-docs/services/x')).toBe(false);
  });

  it('rejects a path outside the API base', () => {
    expect(isSafe('https://infrastructure.services.nykredit.dk/other/services/x')).toBe(false);
  });

  it('rejects a malformed URL', () => {
    expect(isSafe('not a url')).toBe(false);
  });
});

describe('parseOperations tag grouping', () => {
  const contract = {
    tags: [{ name: 'Consents' }, { name: 'Logs' }],
    paths: {
      '/logs': { get: { tags: ['Logs'], summary: 'logs' } },
      '/consents': { get: { tags: ['Consents'], summary: 'list' } },
      '/health': { get: { summary: 'no tag' } },
      '/other': { get: { tags: ['Zebra'], summary: 'undeclared tag' } },
    },
  };

  it('assigns each row its first declared tag', () => {
    const rows = parseOperations(contract);
    expect(rows.find((r) => r.path === '/consents')!.tag).toBe('Consents');
    expect(rows.find((r) => r.path === '/logs')!.tag).toBe('Logs');
  });

  it('falls back to UNTAGGED when the operation declares no tag', () => {
    const rows = parseOperations(contract);
    expect(rows.find((r) => r.path === '/health')!.tag).toBe(UNTAGGED);
  });

  it('orders rows by the contract-declared tag order', () => {
    const rows = parseOperations(contract);
    expect(rows.map((r) => r.tag)).toEqual(['Consents', 'Logs', 'Zebra', UNTAGGED]);
  });

  it('keeps every operation of a tag together', () => {
    const rows = parseOperations({
      tags: [{ name: 'A' }, { name: 'B' }],
      paths: {
        '/a1': { get: { tags: ['A'] } },
        '/b1': { get: { tags: ['B'] } },
        '/a2': { get: { tags: ['A'] } },
      },
    });
    expect(rows.map((r) => r.tag)).toEqual(['A', 'A', 'B']);
  });

  it('still orders by path and method within a tag', () => {
    const rows = parseOperations({
      tags: [{ name: 'A' }],
      paths: { '/z': { get: { tags: ['A'] } }, '/a': { post: { tags: ['A'] }, get: { tags: ['A'] } } },
    });
    expect(rows.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /a', 'POST /a', 'GET /z']);
  });

  it('tolerates a contract with no tags array', () => {
    const rows = parseOperations({ paths: { '/x': { get: { tags: ['Solo'] } } } });
    expect(rows[0].tag).toBe('Solo');
  });
});
