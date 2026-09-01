import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  MAX_BODY_BYTES, bearerOf, buildUrl, executeRequest, isForeignHost, mayAttachToken,
  truncateBody, usableHeaders, withBearer,
} from './rest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('buildUrl', () => {
  it('joins a base URL and a path without doubling the separator', () => {
    expect(buildUrl('https://mortgage.services.nykredit.it', '/consent/consents'))
      .toBe('https://mortgage.services.nykredit.it/consent/consents');
  });

  it('tolerates a trailing slash on the base URL', () => {
    expect(buildUrl('https://x.example.net/', '/a')).toBe('https://x.example.net/a');
  });

  it('adds the leading slash a path is missing', () => {
    expect(buildUrl('https://x.example.net', 'a/b')).toBe('https://x.example.net/a/b');
  });

  it('keeps the query string intact', () => {
    expect(buildUrl('https://x.example.net', '/a?b=1&c=2'))
      .toBe('https://x.example.net/a?b=1&c=2');
  });

  it('keeps a query value that itself contains a question mark', () => {
    expect(buildUrl('https://x.example.net', '/a?q=who%3F?x=1'))
      .toBe('https://x.example.net/a?q=who%3F?x=1');
  });

  it('produces a bare root for an empty path', () => {
    expect(buildUrl('https://x.example.net', '')).toBe('https://x.example.net/');
  });
});

describe('usableHeaders', () => {
  it('drops headers with no value, per requirement 6.2.6', () => {
    expect(usableHeaders([
      { name: 'Accept', value: 'application/json' },
      { name: 'X-Log-Token', value: '' },
      { name: 'X-Other', value: '   ' },
    ])).toEqual([{ name: 'Accept', value: 'application/json' }]);
  });

  it('drops a custom header the user never named', () => {
    expect(usableHeaders([{ name: '', value: 'orphan' }])).toEqual([]);
  });
});

describe('truncateBody', () => {
  it('leaves a normal body alone', () => {
    expect(truncateBody('hello')).toEqual({ body: 'hello', truncated: false });
  });

  it('caps an oversized body and flags it', () => {
    const result = truncateBody('x'.repeat(MAX_BODY_BYTES + 10));
    expect(result.truncated).toBe(true);
    expect(result.body).toHaveLength(MAX_BODY_BYTES);
  });
});

describe('bearerOf / withBearer', () => {
  it('extracts the token actually sent', () => {
    expect(bearerOf([{ name: 'Authorization', value: 'Bearer abc123' }])).toBe('abc123');
  });

  it('matches the header name case-insensitively', () => {
    expect(bearerOf([{ name: 'authorization', value: 'bearer abc' }])).toBe('abc');
  });

  it('returns null when the value is not a bearer token', () => {
    expect(bearerOf([{ name: 'Authorization', value: 'Basic zzz' }])).toBeNull();
    expect(bearerOf([{ name: 'Accept', value: 'application/json' }])).toBeNull();
  });

  it('replaces only the Authorization header', () => {
    expect(withBearer(
      [{ name: 'Authorization', value: 'Bearer old' }, { name: 'Accept', value: 'a/b' }],
      'new'
    )).toEqual([{ name: 'Authorization', value: 'Bearer new' }, { name: 'Accept', value: 'a/b' }]);
  });
});

function response(status: number, body = '', statusText = ''): Response {
  return new Response(body, { status, statusText });
}

const baseRequest = {
  environmentKey: 'local',
  method: 'get',
  path: '/things',
  headers: [{ name: 'Accept', value: 'application/json' }],
  body: '',
  autoAuth: true,
};

describe('executeRequest', () => {
  it('returns a non-2xx verbatim rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(404, 'nope', 'Not Found')));
    const result = await executeRequest('/tmp', baseRequest);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(404);
    expect(result.body).toBe('nope');
    expect(result.error).toBeNull();
  });

  it('returns a 403 without treating it as a configuration error', async () => {
    // withToken would have thrown here; a 403 is a real authorisation answer.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(403, 'forbidden')));
    const result = await executeRequest('/tmp', baseRequest);
    expect(result.status).toBe(403);
    expect(result.error).toBeNull();
  });

  it('uppercases the method and sends an invalid body verbatim', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200, 'ok'));
    vi.stubGlobal('fetch', fetchMock);
    await executeRequest('/tmp', { ...baseRequest, method: 'post', body: '{"not":"valid"' });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"not":"valid"');
  });

  it('omits the body on GET and HEAD, which fetch refuses to send one for', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200, 'ok'));
    vi.stubGlobal('fetch', fetchMock);
    for (const method of ['get', 'head']) {
      fetchMock.mockClear();
      await executeRequest('/tmp', { ...baseRequest, method, body: '{"a":1}' });
      expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
    }
  });

  it('omits the body entirely when it is empty', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200, 'ok'));
    vi.stubGlobal('fetch', fetchMock);
    await executeRequest('/tmp', baseRequest);
    expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
  });

  it('does not follow redirects', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200, 'ok'));
    vi.stubGlobal('fetch', fetchMock);
    await executeRequest('/tmp', baseRequest);
    expect(fetchMock.mock.calls[0][1].redirect).toBe('manual');
  });

  it('drops empty headers before sending', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200, 'ok'));
    vi.stubGlobal('fetch', fetchMock);
    await executeRequest('/tmp', {
      ...baseRequest,
      headers: [{ name: 'Accept', value: 'a/b' }, { name: 'X-Log-Token', value: '' }],
    });
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ Accept: 'a/b' });
  });

  it('reports a transport failure as a result rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND')));
    const result = await executeRequest('/tmp', baseRequest);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ENOTFOUND');
    expect(result.status).toBe(0);
  });

  it('names a timeout explicitly', async () => {
    const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeout));
    const result = await executeRequest('/tmp', baseRequest);
    expect(result.error).toMatch(/timed out/i);
  });

  it('falls back to the default environment for an unknown key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200, 'ok'));
    vi.stubGlobal('fetch', fetchMock);
    const result = await executeRequest('/tmp', { ...baseRequest, environmentKey: 'bogus' });
    expect(result.url).toBe('https://mortgage.services.nykredit.it/things');
  });

  it('never retries a 401 when the user supplied the token themselves', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(401, 'denied'));
    vi.stubGlobal('fetch', fetchMock);
    const result = await executeRequest('/tmp', {
      ...baseRequest,
      autoAuth: false,
      headers: [{ name: 'Authorization', value: 'Bearer typed-by-hand' }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(401);
  });

  it('never retries a 401 against local, which does not use OAuth', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(401, 'denied'));
    vi.stubGlobal('fetch', fetchMock);
    await executeRequest('/tmp', {
      ...baseRequest,
      headers: [{ name: 'Authorization', value: 'Bearer local' }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('truncates an oversized response body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(200, 'y'.repeat(MAX_BODY_BYTES + 5))));
    const result = await executeRequest('/tmp', baseRequest);
    expect(result.truncated).toBe(true);
    expect(result.body).toHaveLength(MAX_BODY_BYTES);
  });

  it('records the request method and url on the result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(200, 'ok')));
    const result = await executeRequest('/tmp', { ...baseRequest, method: 'post' });
    expect(result.method).toBe('POST');
    expect(result.url).toBe('http://127.0.0.1:7001/things');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Followed links (R4)
// ---------------------------------------------------------------------------

describe('mayAttachToken', () => {
  it('allows https anywhere, including hosts outside the environment table', () => {
    expect(mayAttachToken('https://documents.services.totalkredit.dk/d/1')).toBe(true);
  });

  it('refuses plaintext http, which would put the token on the wire in the clear', () => {
    expect(mayAttachToken('http://internal.example.net/a')).toBe(false);
  });

  it('allows loopback over http, which cannot be intercepted off-machine', () => {
    expect(mayAttachToken('http://127.0.0.1:7001/a')).toBe(true);
    expect(mayAttachToken('http://localhost:7001/a')).toBe(true);
  });

  it('refuses a malformed url', () => {
    expect(mayAttachToken('not a url')).toBe(false);
  });
});

describe('isForeignHost', () => {
  it('compares host including port', () => {
    expect(isForeignHost('https://t4.nykreditnet.net/a', 'https://t4.nykreditnet.net')).toBe(false);
    expect(isForeignHost('https://other.example.net/a', 'https://t4.nykreditnet.net')).toBe(true);
  });

  it('treats a malformed url as foreign', () => {
    expect(isForeignHost('nonsense', 'https://t4.nykreditnet.net')).toBe(true);
  });
});

describe('executeRequest with an absolute url', () => {
  const linkRequest = {
    environmentKey: 't4',
    method: 'GET',
    path: '',
    headers: [
      { name: 'Authorization', value: 'Bearer live-token' },
      { name: 'Accept', value: '*/*' },
    ],
    body: '',
    autoAuth: true,
  };

  it('uses the absolute url verbatim rather than the environment base', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200, 'ok'));
    vi.stubGlobal('fetch', fetchMock);
    const result = await executeRequest('/tmp', {
      ...linkRequest, path: '/ignored',
      absoluteUrl: 'https://mortgage.services.nykredit.it/consent/consents/1',
    });
    expect(fetchMock.mock.calls[0][0])
      .toBe('https://mortgage.services.nykredit.it/consent/consents/1');
    expect(result.url).toBe('https://mortgage.services.nykredit.it/consent/consents/1');
  });

  it('still sends the token to a foreign https host, as decided', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200, 'ok'));
    vi.stubGlobal('fetch', fetchMock);
    await executeRequest('/tmp', {
      ...linkRequest, absoluteUrl: 'https://documents.services.totalkredit.dk/d/1',
    });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer live-token');
  });

  it('withholds the token from a plaintext http host', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200, 'ok'));
    vi.stubGlobal('fetch', fetchMock);
    await executeRequest('/tmp', {
      ...linkRequest, absoluteUrl: 'http://internal.example.net/a',
    });
    const sent = fetchMock.mock.calls[0][1].headers;
    expect(sent.Authorization).toBeUndefined();
    expect(sent.Accept).toBe('*/*');
  });

  it('still sends the token to http loopback', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200, 'ok'));
    vi.stubGlobal('fetch', fetchMock);
    await executeRequest('/tmp', {
      ...linkRequest, environmentKey: 'local',
      absoluteUrl: 'http://127.0.0.1:7001/a',
    });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer live-token');
  });

  it('never re-authenticates on a 401 from a foreign host', async () => {
    // Re-minting cannot fix an audience mismatch, and invalidating would throw
    // away the token the Crafter is still using.
    const fetchMock = vi.fn().mockResolvedValue(response(401, 'denied'));
    vi.stubGlobal('fetch', fetchMock);
    const result = await executeRequest('/tmp', {
      ...linkRequest, absoluteUrl: 'https://elsewhere.example.net/a',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(401);
  });

  it('sends GET with no body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200, 'ok'));
    vi.stubGlobal('fetch', fetchMock);
    await executeRequest('/tmp', {
      ...linkRequest, absoluteUrl: 'https://x.example.net/a',
    });
    expect(fetchMock.mock.calls[0][1].method).toBe('GET');
    expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
  });
});
