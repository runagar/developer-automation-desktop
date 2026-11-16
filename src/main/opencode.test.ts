import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OpenCodeHttpError, createOpenCodeConversation, getOpenCodeConversation, getOpenCodeMigrationStatus,
  getOpenCodeServerVersion, getOpenCodeState, isSupportedOpenCodeVersion, requestOpenCode,
} from './opencode';

const connection = { port: 41923, password: 'private-test-password', workingDir: '/work/project with spaces' };
const fetchMock = vi.fn<typeof fetch>();
let replies: Record<string, unknown>;

function reply(value: unknown): Response {
  if (value instanceof Response) return value;
  return new Response(JSON.stringify(value), { status: 200 });
}

function requestedUrls(endpoint: string): URL[] {
  return fetchMock.mock.calls
    .map(([input]) => new URL(String(input)))
    .filter((url) => url.pathname === endpoint);
}

beforeEach(() => {
  replies = {
    '/api/session': { data: { id: 'ses_root' } },
    '/api/session/active': { data: {} },
    '/api/permission/request': { location: { directory: connection.workingDir }, data: [] },
    '/api/form': { location: { directory: connection.workingDir }, data: [] },
  };
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockImplementation(async (input) => {
    const endpoint = new URL(String(input)).pathname;
    if (!(endpoint in replies)) throw new Error(`Unexpected endpoint: ${endpoint}`);
    return reply(replies[endpoint]);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

describe('OpenCode conversation binding', () => {
  it('creates a conversation through authenticated loopback in the session working directory', async () => {
    // Given
    const title = 'Conversation A';
    // When
    const id = await createOpenCodeConversation(connection, title);
    // Then
    expect(id).toBe('ses_root');
    const [input, init] = fetchMock.mock.calls[0];
    const url = new URL(String(input));
    expect(url.origin).toBe('http://127.0.0.1:41923');
    expect(url.search).toBe('');
    expect(url.username).toBe('');
    expect(url.password).toBe('');
    expect(init).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ title, location: { directory: connection.workingDir } }),
      headers: { Authorization: `Basic ${Buffer.from(`opencode:${connection.password}`).toString('base64')}` },
      redirect: 'error',
    });
  });

  it('rejects a response naming another conversation instead of using it', async () => {
    // Given
    replies['/api/session/ses_root'] = { data: { id: 'ses_other' } };
    // When
    const result = getOpenCodeConversation(connection, 'ses_root');
    // Then
    await expect(result).rejects.toThrow('different conversation');
  });

  it('reads a conversation with a null parent as a root conversation', async () => {
    // Given
    replies['/api/session/ses_root'] = { data: { id: 'ses_root', parentID: null } };
    // When
    const conversation = await getOpenCodeConversation(connection, 'ses_root');
    // Then
    expect(conversation).toEqual({ id: 'ses_root', parentID: undefined });
  });

  it('rejects IDs that could become shell arguments or paths', async () => {
    // Given
    replies['/api/session'] = { data: { id: 'ses_root; touch unwanted' } };
    // When
    const result = createOpenCodeConversation(connection, 'A');
    // Then
    await expect(result).rejects.toThrow('invalid conversation ID');
  });

  it('rejects a response without the V2 data envelope', async () => {
    // Given
    replies['/api/session'] = { id: 'ses_root' };
    // When
    const result = createOpenCodeConversation(connection, 'A');
    // Then
    await expect(result).rejects.toThrow('unexpected response');
  });
});

describe('OpenCode state', () => {
  it('reports the bound conversation as running while it is active', async () => {
    // Given
    replies['/api/session/active'] = { data: { ses_root: { type: 'running' } } };
    // When
    const state = await getOpenCodeState(connection, 'ses_root');
    // Then
    expect(state).toBe('running');
  });

  it('recognizes an active list omitting the bound conversation as idle', async () => {
    // Given
    replies['/api/session/active'] = { data: {} };
    // When
    const state = await getOpenCodeState(connection, 'ses_root');
    // Then
    expect(state).toBe('idle');
  });

  it('reports a parent as running while only its background subagent works', async () => {
    // Given
    replies['/api/session/active'] = { data: { ses_child: { type: 'running' } } };
    replies['/api/session/ses_child'] = { data: { id: 'ses_child', parentID: 'ses_root' } };
    // When
    const state = await getOpenCodeState(connection, 'ses_root');
    // Then
    expect(state).toBe('running');
  });

  it('lists pending permissions and forms for the session working directory', async () => {
    // Given
    const expected = connection.workingDir;
    // When
    await getOpenCodeState(connection, 'ses_root');
    // Then
    const directories = ['/api/permission/request', '/api/form']
      .map((endpoint) => requestedUrls(endpoint)[0].searchParams.get('location[directory]'));
    expect(directories).toEqual([expected, expected]);
    expect(requestedUrls('/api/session/active')[0].search).toBe('');
  });

  it.each(['/api/permission/request', '/api/form'])('gives a pending %s precedence over running work', async (endpoint) => {
    // Given
    replies['/api/session/active'] = { data: { ses_root: { type: 'running' } } };
    replies[endpoint] = { data: [{ id: 'request', sessionID: 'ses_root' }] };
    // When
    const state = await getOpenCodeState(connection, 'ses_root');
    // Then
    expect(state).toBe('awaiting');
  });

  it('attributes a nested subagent form to its root, not an unrelated same-project request', async () => {
    // Given
    replies['/api/permission/request'] = { data: [{ sessionID: 'ses_unrelated' }] };
    replies['/api/form'] = { data: [{ sessionID: 'ses_grandchild' }] };
    replies['/api/session/ses_unrelated'] = { data: { id: 'ses_unrelated' } };
    replies['/api/session/ses_grandchild'] = { data: { id: 'ses_grandchild', parentID: 'ses_child' } };
    replies['/api/session/ses_child'] = { data: { id: 'ses_child', parentID: 'ses_root' } };
    // When
    const state = await getOpenCodeState(connection, 'ses_root');
    // Then
    expect(state).toBe('awaiting');
  });

  it('ignores work and forms belonging to another root', async () => {
    // Given
    replies['/api/session/active'] = { data: { ses_other: { type: 'running' } } };
    replies['/api/form'] = { data: [{ sessionID: 'ses_other' }] };
    replies['/api/session/ses_other'] = { data: { id: 'ses_other' } };
    // When
    const state = await getOpenCodeState(connection, 'ses_root');
    // Then
    expect(state).toBe('idle');
    expect(requestedUrls('/api/session/ses_other')).toHaveLength(1);
  });

  it('fails closed on cyclic ancestry instead of guessing that a form is unrelated', async () => {
    // Given
    replies['/api/form'] = { data: [{ sessionID: 'ses_child' }] };
    replies['/api/session/ses_child'] = { data: { id: 'ses_child', parentID: 'ses_child' } };
    // When
    const result = getOpenCodeState(connection, 'ses_root');
    // Then
    await expect(result).rejects.toThrow('invalid conversation ancestry');
  });

  it.each([
    ['/api/session/active', { data: null }],
    ['/api/session/active', { data: { ses_root: { type: 'busy' } } }],
    ['/api/session/active', {}],
    ['/api/permission/request', { data: {} }],
    ['/api/form', { data: [{ id: 'missing session ID' }] }],
  ])('does not turn a malformed %s response into idle', async (endpoint, payload) => {
    // Given
    replies[String(endpoint)] = payload;
    // When
    const result = getOpenCodeState(connection, 'ses_root');
    // Then
    await expect(result).rejects.toThrow();
  });
});

describe('OpenCode server version', () => {
  it('reads the version the server reports', async () => {
    // Given
    replies['/api/info'] = { version: '2.3.0', pid: 1, urls: [], paths: { tmp: '/tmp' } };
    // When
    const version = await getOpenCodeServerVersion(connection);
    // Then
    expect(version).toBe('2.3.0');
  });

  it('reads an OpenCode 1 version from its health check when /api/info serves a web page', async () => {
    // Given
    replies['/api/info'] = new Response('<!doctype html>', { status: 200 });
    replies['/global/health'] = { healthy: true, version: '1.19.5' };
    // When
    const version = await getOpenCodeServerVersion(connection);
    // Then
    expect(version).toBe('1.19.5');
  });

  it('reports the original failure when the server cannot be reached at all', async () => {
    // Given
    fetchMock.mockRejectedValue(new Error('connection refused'));
    // When
    const result = getOpenCodeServerVersion(connection, 10);
    // Then
    await expect(result).rejects.toThrow('/api/info could not be reached');
  });

  it.each([
    ['2.3.0', true],
    ['v2.10.1', true],
    ['1.19.5', false],
    ['3.0.0', false],
    ['', false],
  ])('treats version %s as supported: %s', (version, supported) => {
    // Given
    const reported = version;
    // When
    const result = isSupportedOpenCodeVersion(reported);
    // Then
    expect(result).toBe(supported);
  });
});

describe('OpenCode history migration', () => {
  it.each([
    [{ status: 'completed' }, { status: 'done' }],
    [{ status: 'running', progress: { label: 'Migrating sessions', numerator: 1, denominator: 2 } }, { status: 'pending' }],
    [{ status: 'required' }, { status: 'pending' }],
    [{ status: 'error', error: 'disk full' }, { status: 'failed', error: 'disk full' }],
  ])('maps %j to %j', async (payload, expected) => {
    // Given
    replies['/api/experimental/migration/v1'] = payload;
    // When
    const migration = await getOpenCodeMigrationStatus(connection);
    // Then
    expect(migration).toEqual(expected);
  });

  it('does not wait on a server without the migration endpoint', async () => {
    // Given
    replies['/api/experimental/migration/v1'] = new Response('not found', { status: 404 });
    // When
    const migration = await getOpenCodeMigrationStatus(connection);
    // Then
    expect(migration).toEqual({ status: 'done' });
  });

  it('reports other failures instead of assuming the migration is done', async () => {
    // Given
    replies['/api/experimental/migration/v1'] = new Response('busy', { status: 503 });
    // When
    const result = getOpenCodeMigrationStatus(connection);
    // Then
    await expect(result).rejects.toThrow('HTTP 503');
  });
});

describe('OpenCode request failures', () => {
  it('reports an HTTP failure without including response content or credentials', async () => {
    // Given
    fetchMock.mockResolvedValue(new Response('private conversation content', { status: 401 }));
    // When
    const result = requestOpenCode(connection, '/api/session/active');
    // Then
    await expect(result).rejects.toBeInstanceOf(OpenCodeHttpError);
    await expect(result).rejects.toThrow('HTTP 401');
    await expect(result).rejects.not.toThrow(connection.password);
    await expect(result).rejects.not.toThrow('private conversation content');
  });

  it('reports network timeouts without leaking the underlying request', async () => {
    // Given
    fetchMock.mockRejectedValue(new Error(`request containing ${connection.password} timed out`));
    // When
    const result = requestOpenCode(connection, '/api/session/active', { timeoutMs: 10 });
    // Then
    await expect(result).rejects.toThrow('could not be reached within 10 ms');
    await expect(result).rejects.not.toThrow(connection.password);
  });

  it('rejects invalid JSON and invalid loopback ports', async () => {
    // Given
    fetchMock.mockResolvedValue(new Response('not json'));
    // When
    const jsonResult = requestOpenCode(connection, '/api/session/active');
    const portResult = requestOpenCode({ ...connection, port: 0 }, '/api/session/active');
    // Then
    await expect(jsonResult).rejects.toThrow('invalid JSON');
    await expect(portResult).rejects.toThrow('Invalid OpenCode connection');
  });
});
