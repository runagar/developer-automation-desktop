import { describe, it, expect } from 'vitest';
import { ApiDocsRestSelection, RestResultInfo } from '../../main/types';
import {
  LINK_ACCEPT, applySelection, customParamsFromUrl, filterServices, matchesSearch, parseDraft,
  pathOfUrl, rowKeyOf, selectionFromUrl, serializeDraft, useRestStore,
} from './restStore';

describe('matchesSearch', () => {
  it('matches a partial string', () => {
    expect(matchesSearch('rs-consent-registry', 'consent')).toBe(true);
  });

  it('requires every term to match', () => {
    expect(matchesSearch('rs-consent-registry', 'con reg')).toBe(true);
    expect(matchesSearch('rs-consent', 'con reg')).toBe(false);
  });

  it('is order-independent', () => {
    expect(matchesSearch('rs-consent-registry', 'reg con')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(matchesSearch('Bm4LINS', 'bm4')).toBe(true);
    expect(matchesSearch('rs-consent', 'CONSENT')).toBe(true);
  });

  it('matches everything for an empty or whitespace query', () => {
    expect(matchesSearch('anything', '')).toBe(true);
    expect(matchesSearch('anything', '   ')).toBe(true);
  });
});

describe('filterServices', () => {
  const services = ['api-search', 'rs-consent', 'rs-consent-registry', 'rs-document'];

  it('returns the full list when the query is empty', () => {
    expect(filterServices(services, '')).toEqual(services);
  });

  it('returns every match', () => {
    expect(filterServices(services, 'rs-')).toEqual(
      ['rs-consent', 'rs-consent-registry', 'rs-document']
    );
  });

  it('narrows with multiple terms', () => {
    expect(filterServices(services, 'con reg')).toEqual(['rs-consent-registry']);
  });

  it('returns nothing when no service matches', () => {
    expect(filterServices(services, 'nope')).toEqual([]);
  });
});

describe('rowKeyOf', () => {
  it('keys a row by method and path', () => {
    expect(rowKeyOf({ method: 'GET', path: '/consents' })).toBe('GET /consents');
  });

  it('distinguishes methods on the same path', () => {
    expect(rowKeyOf({ method: 'GET', path: '/x' })).not.toBe(rowKeyOf({ method: 'POST', path: '/x' }));
  });
});

describe('setAllTagsCollapsed', () => {
  // The action is a pure state transform; assert its contract directly.
  function apply(tags: string[], collapsed: boolean): Record<string, boolean> {
    return Object.fromEntries(tags.map((tag) => [tag, collapsed]));
  }

  it('collapses every supplied tag', () => {
    expect(apply(['A', 'B'], true)).toEqual({ A: true, B: true });
  });

  it('expands every supplied tag', () => {
    expect(apply(['A', 'B'], false)).toEqual({ A: false, B: false });
  });

  it('drops tags that are not in the current contract', () => {
    // Rebuilding rather than merging is what prevents a stale tag from a
    // previously viewed contract lingering in the map.
    expect(apply(['A'], true)).not.toHaveProperty('Old');
  });
});

// ---------------------------------------------------------------------------
// REST Crafter (R3)
// ---------------------------------------------------------------------------

function selectionOf(overrides: Partial<ApiDocsRestSelection> = {}): ApiDocsRestSelection {
  return {
    serviceName: 'rs-consent', category: 'default',
    contractType: 'RELEASE', contractVersion: '4.3.0',
    method: 'GET', path: '/consents/{consentId}', fullPath: '/consent/consents/{consentId}',
    acceptVersion: '4', acceptHeader: 'application/json;v=4', produces: ['application/json;v=4'],
    consumesVersion: null, consumesHeader: null, consumes: [],
    requestBodySchema: null, bodySkeleton: '',
    parameters: [
      { name: 'consentId', in: 'path', required: true },
      { name: 'expand', in: 'query' },
      { name: 'X-Log-Token', in: 'header' },
    ],
    deprecated: false, summary: '',
    ...overrides,
  };
}

const emptyState = {
  selection: selectionOf(),
  headerValues: {}, paramValues: {}, customHeaders: [], customParams: [],
  bodyText: '', bodyEdited: false, bodySkeletonBaseline: '',
};

describe('applySelection', () => {
  it('keeps a path parameter shared by the old and new operation', () => {
    // Moving from /consents/{consentId} to /consents/{consentId}/annul.
    const next = selectionOf({
      path: '/consents/{consentId}/annul',
      fullPath: '/consent/consents/{consentId}/annul',
      parameters: [{ name: 'consentId', in: 'path', required: true }],
    });
    const result = applySelection(
      { ...emptyState, paramValues: { 'path:consentId': 'abc-123' } }, next
    );
    expect(result.paramValues).toEqual({ 'path:consentId': 'abc-123' });
  });

  it('drops a query parameter the new operation does not have', () => {
    const next = selectionOf({ parameters: [{ name: 'consentId', in: 'path', required: true }] });
    const result = applySelection(
      { ...emptyState, paramValues: { 'path:consentId': 'x', 'query:expand': 'all' } }, next
    );
    expect(result.paramValues).toEqual({ 'path:consentId': 'x' });
  });

  it('always discards a hand-edited Accept so the media version cannot go stale', () => {
    const result = applySelection(
      { ...emptyState, headerValues: { Accept: 'application/json;v=2', 'X-Log-Token': 'keep' } },
      selectionOf()
    );
    expect(result.headerValues).toEqual({ 'X-Log-Token': 'keep' });
  });

  it('replaces the body when the new operation has a different schema', () => {
    const result = applySelection(
      { ...emptyState, bodyText: '{"mine":1}', bodyEdited: true, bodySkeletonBaseline: '{"a":""}' },
      selectionOf({ requestBodySchema: {}, bodySkeleton: '{"b":""}' })
    );
    expect(result.bodyText).toBe('{"b":""}');
    expect(result.bodyEdited).toBe(false);
  });

  it('keeps a hand-edited body when the schema is identical', () => {
    // Re-picking the same operation from a pre-release must not lose the body.
    const result = applySelection(
      { ...emptyState, bodyText: '{"mine":1}', bodyEdited: true, bodySkeletonBaseline: '{"a":""}' },
      selectionOf({ requestBodySchema: {}, bodySkeleton: '{"a":""}' })
    );
    expect(result.bodyText).toBe('{"mine":1}');
    expect(result.bodyEdited).toBe(true);
  });

  it('clears a hand-edited body when the new operation declares none', () => {
    // A GET picked after a POST must not keep, or inherit, a body.
    const result = applySelection(
      {
        ...emptyState,
        selection: selectionOf({ method: 'POST', requestBodySchema: {}, bodySkeleton: '{"a":""}' }),
        bodyText: '{"mine":1}', bodyEdited: true, bodySkeletonBaseline: '{"a":""}',
      },
      selectionOf({ method: 'GET', requestBodySchema: null, bodySkeleton: '' })
    );
    expect(result.bodyText).toBe('');
    expect(result.bodyEdited).toBe(false);
  });

  it('records the new skeleton as the baseline for the next comparison', () => {
    const result = applySelection(emptyState, selectionOf({ bodySkeleton: '{"x":""}' }));
    expect(result.bodySkeletonBaseline).toBe('{"x":""}');
  });

  it('keeps custom headers when the same resource is re-picked at another version', () => {
    const result = applySelection(
      {
        ...emptyState,
        customHeaders: [{ id: 'c1', name: 'X-Mine', value: '' }],
        headerValues: { 'custom:c1': 'kept' },
      },
      selectionOf({ contractType: 'PRERELEASE', acceptVersion: '3' })
    );
    expect(result.customHeaders).toHaveLength(1);
    expect(result.headerValues['custom:c1']).toBe('kept');
  });

  it('drops custom headers and parameters when the resource changes', () => {
    const result = applySelection(
      {
        ...emptyState,
        customHeaders: [{ id: 'c1', name: 'X-Mine', value: '' }],
        customParams: [{ id: 'q1', name: 'debug', value: '' }],
        headerValues: { 'custom:c1': 'gone' },
        paramValues: { 'custom:q1': 'gone' },
      },
      selectionOf({ path: '/consents/{consentId}/annul' })
    );
    expect(result.customHeaders).toEqual([]);
    expect(result.customParams).toEqual([]);
    expect(result.headerValues).toEqual({});
    expect(result.paramValues).toEqual({});
  });

  it('drops custom rows when the service changes, even at the same path', () => {
    const result = applySelection(
      { ...emptyState, customHeaders: [{ id: 'c1', name: 'X-Mine', value: '' }] },
      selectionOf({ serviceName: 'rs-other' })
    );
    expect(result.customHeaders).toEqual([]);
  });

  it('keeps custom rows restored from a draft, where there is no previous selection', () => {
    // On a cold start the draft's custom headers arrive before any selection
    // does; wiping them here would defeat the draft entirely.
    const result = applySelection(
      {
        ...emptyState, selection: null,
        customHeaders: [{ id: 'c1', name: 'X-Mine', value: '' }],
        headerValues: { 'custom:c1': 'kept' },
      },
      selectionOf()
    );
    expect(result.customHeaders).toHaveLength(1);
    expect(result.headerValues['custom:c1']).toBe('kept');
  });
});

describe('parseDraft', () => {
  const valid = {
    environmentKey: 't4',
    headerValues: { 'X-Log-Token': 'a' },
    customHeaders: [{ id: 'c1', name: 'X-Mine', value: 'v' }],
    paramValues: { 'path:consentId': 'x' },
    customParams: [],
    bodyText: '{"a":1}',
    bodyEdited: true,
    bodySkeletonBaseline: '{"a":""}',
  };

  it('round-trips a well-formed draft', () => {
    expect(parseDraft(JSON.stringify(valid))).toEqual(valid);
  });

  it('returns null for absent or malformed storage', () => {
    expect(parseDraft(null)).toBeNull();
    expect(parseDraft('not json')).toBeNull();
    expect(parseDraft('[]')).toBeNull();
    expect(parseDraft('"a string"')).toBeNull();
  });

  it('rejects a draft with the wrong field types rather than half-loading it', () => {
    expect(parseDraft(JSON.stringify({ ...valid, headerValues: { a: 5 } }))).toBeNull();
    expect(parseDraft(JSON.stringify({ ...valid, customHeaders: [{ id: 1 }] }))).toBeNull();
    expect(parseDraft(JSON.stringify({ ...valid, bodyText: 42 }))).toBeNull();
    expect(parseDraft(JSON.stringify({ ...valid, environmentKey: null }))).toBeNull();
  });

  it('defaults a missing skeleton baseline rather than discarding the draft', () => {
    const { bodySkeletonBaseline, ...without } = valid;
    expect(parseDraft(JSON.stringify(without))?.bodySkeletonBaseline).toBe('');
  });

  it('never carries an Authorization value, which must not reach disk', () => {
    const parsed = parseDraft(JSON.stringify({ ...valid, authValue: 'Bearer secret' }));
    expect(parsed).not.toHaveProperty('authValue');
  });
});

describe('serializeDraft', () => {
  it('serialises a normal draft', () => {
    expect(serializeDraft({
      environmentKey: 'p0', headerValues: {}, customHeaders: [],
      paramValues: {}, customParams: [], bodyText: '{}',
      bodyEdited: false, bodySkeletonBaseline: '',
    })).toContain('"environmentKey":"p0"');
  });

  it('refuses a runaway body instead of filling localStorage', () => {
    expect(serializeDraft({
      environmentKey: 'p0', headerValues: {}, customHeaders: [],
      paramValues: {}, customParams: [], bodyText: 'x'.repeat(300 * 1024),
      bodyEdited: true, bodySkeletonBaseline: '',
    })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Response history (R4)
// ---------------------------------------------------------------------------

function resultOf(overrides: Partial<RestResultInfo> = {}): RestResultInfo {
  return {
    ok: true, status: 200, statusText: 'OK', headers: [], body: '{}',
    truncated: false, durationMs: 12, url: 'https://x.example.net/a', method: 'GET',
    error: null, ...overrides,
  };
}

function freshStore() {
  const store = useRestStore.getState();
  useRestStore.setState({ responses: [], activeResponseId: null });
  return store;
}

function addTab(title: string): string {
  return useRestStore.getState().addResponseTab({
    title, url: `https://x.example.net${title}`, method: 'GET',
    loading: false, result: resultOf(), origin: 'crafter',
  });
}

describe('response tabs', () => {
  it('appends to the right and activates the new tab', () => {
    freshStore();
    const first = addTab('/a');
    const second = addTab('/b');
    const { responses, activeResponseId } = useRestStore.getState();
    expect(responses.map((r) => r.id)).toEqual([first, second]);
    expect(activeResponseId).toBe(second);
  });

  it('keeps a tab per send, so repeated sends are comparable', () => {
    freshStore();
    addTab('/same');
    addTab('/same');
    expect(useRestStore.getState().responses).toHaveLength(2);
  });

  it('activates the right-hand neighbour when the active tab is closed', () => {
    freshStore();
    const a = addTab('/a');
    const b = addTab('/b');
    const c = addTab('/c');
    useRestStore.getState().setActiveResponse(b);
    useRestStore.getState().closeResponseTab(b);
    expect(useRestStore.getState().activeResponseId).toBe(c);
    expect(useRestStore.getState().responses.map((r) => r.id)).toEqual([a, c]);
  });

  it('falls back to the left when the last tab is closed', () => {
    freshStore();
    const a = addTab('/a');
    const b = addTab('/b');
    useRestStore.getState().closeResponseTab(b);
    expect(useRestStore.getState().activeResponseId).toBe(a);
  });

  it('leaves no active tab once the final one is closed', () => {
    freshStore();
    const only = addTab('/a');
    useRestStore.getState().closeResponseTab(only);
    expect(useRestStore.getState().responses).toEqual([]);
    expect(useRestStore.getState().activeResponseId).toBeNull();
  });

  it('does not change the active tab when a background tab is closed', () => {
    freshStore();
    const a = addTab('/a');
    const b = addTab('/b');
    useRestStore.getState().closeResponseTab(a);
    expect(useRestStore.getState().activeResponseId).toBe(b);
  });

  it('ignores a close for an unknown id', () => {
    freshStore();
    addTab('/a');
    useRestStore.getState().closeResponseTab('nope');
    expect(useRestStore.getState().responses).toHaveLength(1);
  });

  it('settles the right tab when several are open', () => {
    freshStore();
    const pending = useRestStore.getState().addResponseTab({
      title: '/slow', url: 'https://x.example.net/slow', method: 'GET',
      loading: true, result: null, origin: 'link',
    });
    const other = addTab('/other');
    useRestStore.getState().settleResponseTab(pending, resultOf({ status: 201 }));
    const byId = Object.fromEntries(useRestStore.getState().responses.map((r) => [r.id, r]));
    expect(byId[pending].loading).toBe(false);
    expect(byId[pending].result?.status).toBe(201);
    expect(byId[other].result?.status).toBe(200);
  });

  it('adopts the executed url when a tab settles', () => {
    freshStore();
    const id = useRestStore.getState().addResponseTab({
      title: '/x', url: 'https://x.example.net/x', method: 'GET',
      loading: true, result: null, origin: 'link',
    });
    useRestStore.getState().settleResponseTab(id, resultOf({ url: 'https://real.example.net/x' }));
    expect(useRestStore.getState().responses[0].url).toBe('https://real.example.net/x');
  });
});

describe('pathOfUrl', () => {
  it('reduces a URL to its path and query for the tab title', () => {
    expect(pathOfUrl('https://mortgage.services.nykredit.it/consent/consents/97ca?x=1'))
      .toBe('/consent/consents/97ca?x=1');
  });

  it('returns the input unchanged when it is not a URL', () => {
    expect(pathOfUrl('not a url')).toBe('not a url');
  });
});

describe('selectionFromUrl', () => {
  it('takes the path and names the service from its first segment', () => {
    const sel = selectionFromUrl('https://mortgage.services.nykredit.it/effective-mortgage-loan/loans/4c87');
    expect(sel.fullPath).toBe('/effective-mortgage-loan/loans/4c87');
    expect(sel.serviceName).toBe('effective-mortgage-loan');
    expect(sel.method).toBe('GET');
  });

  it('excludes the query string from the path, which becomes parameters instead', () => {
    const sel = selectionFromUrl('https://x.example.net/a/b?limit=10');
    expect(sel.fullPath).toBe('/a/b');
  });

  it('defaults the accept-version to the one the link was tried with', () => {
    const sel = selectionFromUrl('https://x.example.net/a');
    expect(sel.acceptHeader).toBe(LINK_ACCEPT);
    expect(sel.acceptVersion).toBe('1');
  });

  it('declares no parameters and no body, since there is no contract', () => {
    const sel = selectionFromUrl('https://x.example.net/a');
    expect(sel.parameters).toEqual([]);
    expect(sel.requestBodySchema).toBeNull();
    expect(sel.bodySkeleton).toBe('');
  });

  it('falls back to the host when the path has no segments', () => {
    expect(selectionFromUrl('https://x.example.net/').serviceName).toBe('x.example.net');
  });

  it('survives a malformed url', () => {
    expect(() => selectionFromUrl('not a url')).not.toThrow();
  });
});

describe('customParamsFromUrl', () => {
  it('turns each query parameter into a named row', () => {
    expect(customParamsFromUrl('https://x.example.net/a?limit=10&expand=all'))
      .toEqual([
        { id: 'link-0', name: 'limit', value: '10' },
        { id: 'link-1', name: 'expand', value: 'all' },
      ]);
  });

  it('decodes percent-encoded values', () => {
    expect(customParamsFromUrl('https://x.example.net/a?q=a%20b')[0].value).toBe('a b');
  });

  it('returns nothing for a url without a query', () => {
    expect(customParamsFromUrl('https://x.example.net/a')).toEqual([]);
    expect(customParamsFromUrl('not a url')).toEqual([]);
  });
});

describe('copyLinkToCrafter', () => {
  function linkTab(url: string): string {
    useRestStore.setState({ responses: [], activeResponseId: null });
    return useRestStore.getState().addResponseTab({
      title: pathOfUrl(url), url, method: 'GET',
      loading: false, result: resultOf({ url }), origin: 'link',
    });
  }

  it('loads the link path and query into the crafter', () => {
    const id = linkTab('https://t4.nykreditnet.net/consent/consents?limit=5');
    useRestStore.getState().copyLinkToCrafter(id);
    const s = useRestStore.getState();
    expect(s.selection?.fullPath).toBe('/consent/consents');
    expect(s.customParams).toEqual([{ id: 'link-0', name: 'limit', value: '5' }]);
    expect(s.paramValues['custom:link-0']).toBe('5');
  });

  it('switches to the environment that serves the link', () => {
    useRestStore.setState({
      environmentKey: 'p0',
      environments: [
        { key: 'p0', label: 'p0', baseUrl: 'https://mortgage.services.nykredit.it', securityHost: 'h', auth: 'oauth' },
        { key: 't4', label: 't4', baseUrl: 'https://t4.nykreditnet.net', securityHost: 'h', auth: 'oauth' },
      ],
    });
    const id = linkTab('https://t4.nykreditnet.net/consent/consents');
    useRestStore.getState().copyLinkToCrafter(id);
    expect(useRestStore.getState().environmentKey).toBe('t4');
    expect(useRestStore.getState().crafterError).toBeNull();
  });

  it('warns rather than silently retargeting when the host is unknown', () => {
    useRestStore.setState({
      environmentKey: 'p0',
      environments: [
        { key: 'p0', label: 'p0', baseUrl: 'https://mortgage.services.nykredit.it', securityHost: 'h', auth: 'oauth' },
      ],
    });
    const id = linkTab('https://documents.services.totalkredit.dk/d/1');
    useRestStore.getState().copyLinkToCrafter(id);
    const s = useRestStore.getState();
    expect(s.environmentKey).toBe('p0');
    expect(s.crafterError).toMatch(/outside the selected environment/);
  });

  it('ignores an unknown tab id', () => {
    useRestStore.setState({ responses: [], activeResponseId: null });
    expect(() => useRestStore.getState().copyLinkToCrafter('nope')).not.toThrow();
  });
});
