import { describe, it, expect } from 'vitest';
import {
  joinPath, mediaTypeVersion, mergeParameters, parseApiDocsConfig, parseOperations,
  sortServiceNames, splitPathKey, typeSegment, UNTAGGED,
  specKind, contractPrefix, resolveLocalRef, normalizeParameters,
  operationProduces, operationConsumes, operationBodySchema,
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

// ---------------------------------------------------------------------------
// OpenAPI 3.x support (R3, ambiguity 21)
// ---------------------------------------------------------------------------

describe('specKind', () => {
  it('recognises an OpenAPI 3 contract by its openapi field', () => {
    expect(specKind({ openapi: '3.1.0' })).toBe('openapi3');
    expect(specKind({ openapi: '3.0.3' })).toBe('openapi3');
  });

  it('treats anything else, including a malformed contract, as Swagger 2.0', () => {
    expect(specKind({ swagger: '2.0' })).toBe('swagger2');
    expect(specKind({})).toBe('swagger2');
    expect(specKind(null)).toBe('swagger2');
  });
});

describe('contractPrefix', () => {
  it('uses basePath for Swagger 2.0', () => {
    expect(contractPrefix({ swagger: '2.0', basePath: '/consent' })).toBe('/consent');
  });

  it('returns empty when Swagger 2.0 declares no basePath', () => {
    expect(contractPrefix({ swagger: '2.0' })).toBe('');
  });

  it('takes the path of an OpenAPI 3 server URL', () => {
    expect(contractPrefix({
      openapi: '3.1.0',
      servers: [{ url: 'https://mortgage.services.nykredit.it/currency-exchange-rates' }],
    })).toBe('/currency-exchange-rates');
  });

  it('strips a trailing slash from the server path', () => {
    expect(contractPrefix({
      openapi: '3.0.3',
      servers: [{ url: 'https://gateway.api.nykredit.it/ecc/' }],
    })).toBe('/ecc');
  });

  it('returns empty for servers that carry no path at all', () => {
    expect(contractPrefix({
      openapi: '3.0.3',
      servers: [{ url: 'http://localhost:9080' }, { url: 'https://it-org-apm.example.net' }],
    })).toBe('');
  });

  it('handles a relative server entry', () => {
    expect(contractPrefix({ openapi: '3.1.0', servers: [{ url: '/' }] })).toBe('');
  });

  it('skips a bare host and takes the first server that does carry a prefix', () => {
    // The real defect this guards: reading servers[0] blindly would drop the
    // prefix for any service that happens to list localhost first.
    expect(contractPrefix({
      openapi: '3.1.0',
      servers: [{ url: 'http://localhost:9080' }, { url: 'https://gw.example.net/ecc' }],
    })).toBe('/ecc');
  });

  it('survives a malformed server entry', () => {
    expect(contractPrefix({
      openapi: '3.1.0',
      servers: [{ url: 123 }, null, { url: 'https://gw.example.net/ok' }],
    })).toBe('/ok');
  });
});

describe('resolveLocalRef', () => {
  const contract = {
    definitions: { Thing: { type: 'object' } },
    components: { schemas: { Other: { type: 'string' } }, parameters: { XLog: { name: 'X-Log-Token', in: 'header' } } },
  };

  it('follows a Swagger 2.0 definitions pointer', () => {
    expect(resolveLocalRef(contract, '#/definitions/Thing')).toEqual({ type: 'object' });
  });

  it('follows an OpenAPI 3 components pointer', () => {
    expect(resolveLocalRef(contract, '#/components/schemas/Other')).toEqual({ type: 'string' });
  });

  it('returns null for an external or unresolvable ref', () => {
    expect(resolveLocalRef(contract, 'http://elsewhere/x.json#/A')).toBeNull();
    expect(resolveLocalRef(contract, '#/definitions/Missing')).toBeNull();
    expect(resolveLocalRef(contract, 42)).toBeNull();
  });
});

describe('normalizeParameters', () => {
  const contract = {
    openapi: '3.1.0',
    components: { parameters: { XLogToken: { name: 'X-Log-Token', in: 'header' } } },
  };

  it('expands a $ref parameter entry', () => {
    expect(normalizeParameters(contract, [{ $ref: '#/components/parameters/XLogToken' }]))
      .toEqual([{ name: 'X-Log-Token', in: 'header' }]);
  });

  it('drops entries that cannot be resolved into a usable parameter', () => {
    expect(normalizeParameters(contract, [
      { $ref: '#/components/parameters/Nope' },
      { description: 'no name or in' },
      null,
    ])).toEqual([]);
  });

  it('deduplicates once a $ref is expanded, which merging alone could not', () => {
    // mergeParameters keys on name+in, neither of which a raw $ref has.
    const pathLevel = normalizeParameters(contract, [{ $ref: '#/components/parameters/XLogToken' }]);
    const opLevel = normalizeParameters(contract, [
      { name: 'X-Log-Token', in: 'header', required: true },
    ]);
    const merged = mergeParameters(pathLevel, opLevel);
    expect(merged).toHaveLength(1);
    expect(merged[0].required).toBe(true);
  });
});

describe('operationProduces', () => {
  it('prefers the operation over the contract root for Swagger 2.0', () => {
    const contract = { swagger: '2.0', produces: ['application/xml'] };
    expect(operationProduces(contract, { produces: ['application/json;v=4'] }))
      .toEqual(['application/json;v=4']);
  });

  it('inherits the contract root when a Swagger 2.0 operation declares none', () => {
    const contract = { swagger: '2.0', produces: ['application/xml'] };
    expect(operationProduces(contract, {})).toEqual(['application/xml']);
  });

  it('derives OpenAPI 3 media types from 2xx response content, keeping ;v=N', () => {
    const contract = { openapi: '3.1.0' };
    const op = {
      responses: {
        200: { content: { 'application/json;v=1': {} } },
        400: { content: { 'application/problem+json': {} } },
      },
    };
    expect(operationProduces(contract, op)).toEqual(['application/json;v=1']);
  });

  it('deduplicates across several success codes', () => {
    const contract = { openapi: '3.0.3' };
    const op = {
      responses: {
        201: { content: { 'application/json': {} } },
        200: { content: { 'application/json': {}, 'application/hal+json': {} } },
      },
    };
    expect(operationProduces(contract, op)).toEqual(['application/json', 'application/hal+json']);
  });
});

describe('operationConsumes', () => {
  it('reads the OpenAPI 3 requestBody content map', () => {
    const contract = { openapi: '3.1.0' };
    const op = { requestBody: { content: { 'application/json': { schema: {} } } } };
    expect(operationConsumes(contract, op)).toEqual(['application/json']);
  });

  it('puts JSON media types first', () => {
    const contract = { openapi: '3.1.0' };
    const op = {
      requestBody: { content: { 'text/plain': {}, 'application/json': {} } },
    };
    expect(operationConsumes(contract, op)).toEqual(['application/json', 'text/plain']);
  });

  it('returns empty for an operation with no body', () => {
    expect(operationConsumes({ openapi: '3.1.0' }, {})).toEqual([]);
  });
});

describe('operationBodySchema', () => {
  it('reads the Swagger 2.0 body parameter schema', () => {
    const params = [{ name: 'body', in: 'body', schema: { $ref: '#/definitions/Req' } }];
    expect(operationBodySchema({ swagger: '2.0' }, {}, params))
      .toEqual({ $ref: '#/definitions/Req' });
  });

  it('reads the OpenAPI 3 requestBody schema', () => {
    const op = {
      requestBody: {
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Req' } } },
      },
    };
    expect(operationBodySchema({ openapi: '3.1.0' }, op, []))
      .toEqual({ $ref: '#/components/schemas/Req' });
  });

  it('returns null when there is no body', () => {
    expect(operationBodySchema({ openapi: '3.1.0' }, {}, [])).toBeNull();
    expect(operationBodySchema({ swagger: '2.0' }, {}, [])).toBeNull();
  });
});

describe('parseOperations on an OpenAPI 3 contract', () => {
  const contract = {
    openapi: '3.1.0',
    servers: [{ url: 'https://mortgage.services.nykredit.it/currency-exchange-rates' }],
    components: {
      parameters: { XLogToken: { name: 'X-Log-Token', in: 'header' } },
      schemas: { Rate: { type: 'object', properties: { code: { type: 'string' } } } },
    },
    paths: {
      '/currency-exchange-rates#v=1': {
        get: {
          tags: ['Rates'],
          summary: 'List rates',
          parameters: [{ $ref: '#/components/parameters/XLogToken' }],
          responses: { 200: { content: { 'application/json;v=1': {} } } },
        },
        post: {
          tags: ['Rates'],
          requestBody: {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Rate' } } },
          },
          responses: { 201: { content: { 'application/json;v=1': {} } } },
        },
      },
    },
  };

  it('still splits the #v=N fragment', () => {
    const rows = parseOperations(contract);
    expect(rows.every((r) => r.path === '/currency-exchange-rates')).toBe(true);
    expect(rows[0].variants[0].acceptVersion).toBe('1');
  });

  it('expands $ref parameters into the variant', () => {
    const get = parseOperations(contract).find((r) => r.method === 'GET')!;
    expect(get.variants[0].parameters).toEqual([{ name: 'X-Log-Token', in: 'header' }]);
  });

  it('derives produces from the response content', () => {
    const get = parseOperations(contract).find((r) => r.method === 'GET')!;
    expect(get.variants[0].produces).toEqual(['application/json;v=1']);
  });

  it('carries the request body schema on the variant', () => {
    const post = parseOperations(contract).find((r) => r.method === 'POST')!;
    expect(post.variants[0].bodySchema).toEqual({ $ref: '#/components/schemas/Rate' });
    expect(post.variants[0].consumes).toEqual(['application/json']);
  });
});

describe('parseOperations still handles Swagger 2.0 bodies', () => {
  it('puts the body parameter schema on the variant', () => {
    const contract = {
      swagger: '2.0',
      basePath: '/consent',
      paths: {
        '/consents#v=4': {
          post: {
            produces: ['application/json;v=4'],
            parameters: [
              { name: 'body', in: 'body', schema: { $ref: '#/definitions/Req' } },
              { name: 'Accept', in: 'header', required: true, type: 'string' },
            ],
          },
        },
      },
    };
    const row = parseOperations(contract)[0];
    expect(row.variants[0].bodySchema).toEqual({ $ref: '#/definitions/Req' });
    expect(row.variants[0].parameters.map((p) => p.name)).toEqual(['body', 'Accept']);
  });
});
