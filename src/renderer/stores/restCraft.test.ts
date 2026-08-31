import { describe, it, expect } from 'vitest';
import { ApiDocsParameter, ApiDocsRestSelection } from '../../main/types';
import {
  ACCEPT, AUTHORIZATION, CONTENT_TYPE, buildQuery, carryOverValues, craftedPath,
  defaultHeaderRows, defaultParamRows, effectiveValue, keepEditedBody, missingPathParams,
  requestHeaders, substitutePath, takesBody,
} from './restCraft';

function selectionOf(overrides: Partial<ApiDocsRestSelection> = {}): ApiDocsRestSelection {
  return {
    serviceName: 'rs-consent',
    category: 'default',
    contractType: 'RELEASE',
    contractVersion: '4.3.0',
    method: 'GET',
    path: '/consents/{consentId}',
    fullPath: '/consent/consents/{consentId}',
    acceptVersion: '4',
    acceptHeader: 'application/json;v=4',
    produces: ['application/json;v=4'],
    consumesVersion: null,
    consumesHeader: null,
    consumes: [],
    requestBodySchema: null,
    bodySkeleton: '',
    parameters: [],
    deprecated: false,
    summary: 'Get a consent',
    ...overrides,
  };
}

const param = (p: Partial<ApiDocsParameter> & { name: string; in: string }): ApiDocsParameter => p;

describe('takesBody', () => {
  it('is false when the operation declares no body schema', () => {
    expect(takesBody(selectionOf())).toBe(false);
    expect(takesBody(null)).toBe(false);
  });

  it('is true once a body schema is present', () => {
    expect(takesBody(selectionOf({ requestBodySchema: { type: 'object' } }))).toBe(true);
  });
});

describe('defaultHeaderRows', () => {
  it('always includes Authorization, even for an operation that documents none', () => {
    expect(defaultHeaderRows(null, [])[0].name).toBe(AUTHORIZATION);
  });

  it('orders Authorization, Accept, Content-Type, contract headers, then custom', () => {
    const selection = selectionOf({
      requestBodySchema: { type: 'object' },
      consumesHeader: 'application/json',
      parameters: [param({ name: 'X-Log-Token', in: 'header' })],
    });
    const names = defaultHeaderRows(selection, [{ id: 'c1', name: 'X-Mine', value: 'v' }])
      .map((r) => r.name);
    expect(names).toEqual([AUTHORIZATION, ACCEPT, CONTENT_TYPE, 'X-Log-Token', 'X-Mine']);
  });

  it('pre-fills Accept from the operation media type, not the parameter default', () => {
    const selection = selectionOf({
      parameters: [param({ name: 'Accept', in: 'header', required: true, description: 'Valid: v4' })],
    });
    const accept = defaultHeaderRows(selection, []).find((r) => r.name === ACCEPT)!;
    expect(accept.defaultValue).toBe('application/json;v=4');
    expect(accept.description).toBe('Valid: v4');
  });

  it('lists Accept only once even though the contract declares it as a parameter', () => {
    const selection = selectionOf({
      parameters: [param({ name: 'Accept', in: 'header', required: true })],
    });
    const accepts = defaultHeaderRows(selection, []).filter((r) => r.name === ACCEPT);
    expect(accepts).toHaveLength(1);
  });

  it('offers a dropdown for Accept only when several media types exist', () => {
    const one = defaultHeaderRows(selectionOf(), []).find((r) => r.name === ACCEPT)!;
    expect(one.options).toEqual([]);
    const many = defaultHeaderRows(
      selectionOf({ produces: ['application/json;v=4', 'application/hal+json'] }), []
    ).find((r) => r.name === ACCEPT)!;
    expect(many.options).toHaveLength(2);
  });

  it('omits Content-Type for an operation with no body', () => {
    expect(defaultHeaderRows(selectionOf(), []).map((r) => r.name)).not.toContain(CONTENT_TYPE);
  });

  it('falls back to application/json when a body operation declares no consumes', () => {
    // 14 of 59 sampled body operations declare no `consumes` at all.
    const selection = selectionOf({ requestBodySchema: { type: 'object' }, consumesHeader: null });
    const row = defaultHeaderRows(selection, []).find((r) => r.name === CONTENT_TYPE)!;
    expect(row.defaultValue).toBe('application/json');
  });

  it('puts required contract headers before optional ones', () => {
    const selection = selectionOf({
      parameters: [
        param({ name: 'X-Optional', in: 'header' }),
        param({ name: 'X-Required', in: 'header', required: true }),
      ],
    });
    const contract = defaultHeaderRows(selection, []).filter((r) => r.kind === 'contract');
    expect(contract.map((r) => r.name)).toEqual(['X-Required', 'X-Optional']);
  });

  it('exposes an enum as dropdown options with its documented default', () => {
    const selection = selectionOf({
      parameters: [param({
        name: 'nykreditRealkreditRole', in: 'header',
        enum: ['TOTALKREDIT_PI', 'NYKREDIT'], default: 'TOTALKREDIT_PI',
      })],
    });
    const row = defaultHeaderRows(selection, []).find((r) => r.name === 'nykreditRealkreditRole')!;
    expect(row.options).toEqual(['TOTALKREDIT_PI', 'NYKREDIT']);
    expect(row.defaultValue).toBe('TOTALKREDIT_PI');
  });

  it('makes only custom headers removable', () => {
    const rows = defaultHeaderRows(selectionOf(), [{ id: 'c1', name: 'X-Mine', value: '' }]);
    expect(rows.filter((r) => r.removable).map((r) => r.name)).toEqual(['X-Mine']);
  });

  it('does not duplicate a contract-declared Authorization or Content-Type', () => {
    const selection = selectionOf({
      requestBodySchema: {},
      parameters: [
        param({ name: 'authorization', in: 'header' }),
        param({ name: 'Content-Type', in: 'header' }),
      ],
    });
    const names = defaultHeaderRows(selection, []).map((r) => r.name);
    expect(names.filter((n) => n.toLowerCase() === 'authorization')).toHaveLength(1);
    expect(names.filter((n) => n.toLowerCase() === 'content-type')).toHaveLength(1);
  });
});

describe('defaultParamRows', () => {
  const selection = selectionOf({
    parameters: [
      param({ name: 'expand', in: 'query' }),
      param({ name: 'consentId', in: 'path', required: true }),
      param({ name: 'X-Log-Token', in: 'header' }),
    ],
  });

  it('lists path and query parameters only, never headers or the body', () => {
    expect(defaultParamRows(selection, []).map((r) => r.name)).toEqual(['consentId', 'expand']);
  });

  it('marks the location of each row', () => {
    const rows = defaultParamRows(selection, []);
    expect(rows[0].location).toBe('path');
    expect(rows[1].location).toBe('query');
  });

  it('treats a path parameter as required even when the contract omits the flag', () => {
    const rows = defaultParamRows(
      selectionOf({ parameters: [param({ name: 'id', in: 'path' })] }), []
    );
    expect(rows[0].required).toBe(true);
  });

  it('appends custom query parameters as removable rows', () => {
    const rows = defaultParamRows(selection, [{ id: 'q1', name: 'debug', value: 'true' }]);
    expect(rows[rows.length - 1]).toMatchObject({ name: 'debug', location: 'query', removable: true });
  });
});

describe('effectiveValue', () => {
  it('prefers what the user typed over the documented default', () => {
    expect(effectiveValue({ key: 'k', defaultValue: 'doc' }, { k: 'typed' })).toBe('typed');
  });

  it('falls back to the documented default', () => {
    expect(effectiveValue({ key: 'k', defaultValue: 'doc' }, {})).toBe('doc');
  });

  it('respects an explicit empty string, so a default can be cleared', () => {
    // Requirement 6.2.6 needs "cleared to nothing" to be reachable.
    expect(effectiveValue({ key: 'k', defaultValue: 'doc' }, { k: '' })).toBe('');
  });
});

describe('substitutePath', () => {
  const rows = defaultParamRows(
    selectionOf({ parameters: [param({ name: 'consentId', in: 'path', required: true })] }), []
  );

  it('leaves an unfilled placeholder literal', () => {
    expect(substitutePath('/consent/consents/{consentId}', rows, {}))
      .toBe('/consent/consents/{consentId}');
  });

  it('substitutes a filled value', () => {
    expect(substitutePath('/consent/consents/{consentId}', rows, { 'path:consentId': 'abc' }))
      .toBe('/consent/consents/abc');
  });

  it('percent-encodes the substituted value', () => {
    expect(substitutePath('/c/{consentId}', rows, { 'path:consentId': 'a b/c' }))
      .toBe('/c/a%20b%2Fc');
  });

  it('leaves a placeholder with no matching parameter alone', () => {
    expect(substitutePath('/c/{unknown}', rows, {})).toBe('/c/{unknown}');
  });
});

describe('buildQuery', () => {
  const rows = defaultParamRows(selectionOf({
    parameters: [
      param({ name: 'expand', in: 'query' }),
      param({ name: 'limit', in: 'query', default: 10 }),
    ],
  }), []);

  it('omits parameters with no value', () => {
    expect(buildQuery(
      defaultParamRows(selectionOf({ parameters: [param({ name: 'expand', in: 'query' })] }), []),
      {}
    )).toBe('');
  });

  it('includes a documented default', () => {
    expect(buildQuery(rows, {})).toBe('?limit=10');
  });

  it('encodes names and values', () => {
    expect(buildQuery(rows, { 'query:expand': 'a b&c' })).toBe('?expand=a%20b%26c&limit=10');
  });

  it('skips a custom parameter the user never named', () => {
    const withOrphan = defaultParamRows(selectionOf(), [{ id: 'x', name: '', value: 'v' }]);
    expect(buildQuery(withOrphan, { 'custom:x': 'v' })).toBe('');
  });
});

describe('craftedPath', () => {
  it('is empty without a selection', () => {
    expect(craftedPath(null, [], {})).toBe('');
  });

  it('combines substitution and the query string', () => {
    const selection = selectionOf({
      parameters: [
        param({ name: 'consentId', in: 'path', required: true }),
        param({ name: 'expand', in: 'query' }),
      ],
    });
    const rows = defaultParamRows(selection, []);
    expect(craftedPath(selection, rows, { 'path:consentId': 'x1', 'query:expand': 'all' }))
      .toBe('/consent/consents/x1?expand=all');
  });
});

describe('missingPathParams', () => {
  const selection = selectionOf({
    parameters: [
      param({ name: 'consentId', in: 'path', required: true }),
      param({ name: 'expand', in: 'query', required: true }),
    ],
  });
  const rows = defaultParamRows(selection, []);

  it('reports an unfilled path parameter', () => {
    expect(missingPathParams(rows, {})).toEqual(['consentId']);
  });

  it('never reports a query parameter, even a required one', () => {
    // Deliberate: "what does the API do without it" is a legitimate test.
    expect(missingPathParams(rows, { 'path:consentId': 'x' })).toEqual([]);
  });

  it('treats a whitespace-only value as missing', () => {
    expect(missingPathParams(rows, { 'path:consentId': '   ' })).toEqual(['consentId']);
  });
});

describe('requestHeaders', () => {
  it('takes the Authorization value from the token field, not the value map', () => {
    const rows = defaultHeaderRows(selectionOf(), []);
    const sent = requestHeaders(rows, { [AUTHORIZATION]: 'ignored' }, 'Bearer live');
    expect(sent.find((h) => h.name === AUTHORIZATION)?.value).toBe('Bearer live');
  });

  it('sends documented defaults for untouched rows', () => {
    const rows = defaultHeaderRows(selectionOf(), []);
    expect(requestHeaders(rows, {}, '').find((h) => h.name === ACCEPT)?.value)
      .toBe('application/json;v=4');
  });
});

describe('carryOverValues', () => {
  it('keeps values whose row still exists', () => {
    expect(carryOverValues({ a: '1', b: '2' }, [{ key: 'a' }])).toEqual({ a: '1' });
  });

  it('drops values with no matching row', () => {
    expect(carryOverValues({ gone: 'x' }, [{ key: 'other' }])).toEqual({});
  });
});

describe('keepEditedBody', () => {
  it('keeps an edited body when the schema is unchanged', () => {
    expect(keepEditedBody(true, '{"a":1}', '{"a":1}')).toBe(true);
  });

  it('discards an edited body when the schema changed', () => {
    expect(keepEditedBody(true, '{"a":1}', '{"b":2}')).toBe(false);
  });

  it('never keeps a body the user did not edit', () => {
    expect(keepEditedBody(false, '{"a":1}', '{"a":1}')).toBe(false);
  });
});
