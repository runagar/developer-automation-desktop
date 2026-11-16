import type { SessionState } from './types';

export interface OpenCodeConnection {
  port: number;
  password: string;
  workingDir: string;
}

interface OpenCodeConversation {
  id: string;
  parentID?: string;
}

interface OpenCodeRequestOptions {
  body?: unknown;
  query?: Record<string, string>;
  timeoutMs?: number;
}

export type OpenCodeMigration =
  | { status: 'done' }
  | { status: 'pending' }
  | { status: 'failed'; error: string };

export class OpenCodeHttpError extends Error {
  constructor(readonly endpoint: string, readonly status: number) {
    super(`OpenCode ${endpoint} failed (HTTP ${status})`);
  }
}

export const OPENCODE_INSTALL_COMMAND = 'curl -fsSL https://opencode.ai/v2/install | bash';
const SUPPORTED_MAJOR_VERSION = 2;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateOpenCodeSessionId(value: unknown): string {
  if (typeof value !== 'string' || !/^ses_[A-Za-z0-9]+$/.test(value)) {
    throw new Error('OpenCode returned an invalid conversation ID');
  }
  return value;
}

export function isSupportedOpenCodeVersion(version: string): boolean {
  return Number(/^v?(\d+)\.\d+/.exec(version.trim())?.[1]) === SUPPORTED_MAJOR_VERSION;
}

export async function requestOpenCode(
  connection: OpenCodeConnection,
  endpoint: string,
  options: OpenCodeRequestOptions = {},
): Promise<unknown> {
  const { body, query = {}, timeoutMs = 3000 } = options;
  if (!Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535 ||
      !connection.password || !endpoint.startsWith('/') || endpoint.startsWith('//')) {
    throw new Error('Invalid OpenCode connection');
  }
  const url = new URL(`http://127.0.0.1:${connection.port}`);
  url.pathname = endpoint;
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  let response: Response;
  try {
    response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`opencode:${connection.password}`).toString('base64')}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
  } catch {
    throw new Error(`OpenCode ${endpoint} could not be reached within ${timeoutMs} ms`);
  }
  if (!response.ok) throw new OpenCodeHttpError(endpoint, response.status);
  try {
    return await response.json();
  } catch {
    throw new Error(`OpenCode ${endpoint} returned invalid JSON`);
  }
}

function readData(value: unknown): unknown {
  if (!isRecord(value) || !('data' in value)) throw new Error('OpenCode returned an unexpected response');
  return value.data;
}

function locationQuery(connection: OpenCodeConnection): Record<string, string> {
  return { 'location[directory]': connection.workingDir };
}

function parseConversation(value: unknown): OpenCodeConversation {
  if (!isRecord(value)) throw new Error('OpenCode returned an invalid conversation');
  const id = validateOpenCodeSessionId(value.id);
  const parentID = value.parentID === undefined || value.parentID === null
    ? undefined
    : validateOpenCodeSessionId(value.parentID);
  return { id, parentID };
}

export async function getOpenCodeServerVersion(connection: OpenCodeConnection, timeoutMs = 1000): Promise<string> {
  let info: unknown;
  try {
    info = await requestOpenCode(connection, '/api/info', { timeoutMs });
  } catch (infoError) {
    info = await requestOpenCode(connection, '/global/health', { timeoutMs }).catch(() => {
      throw infoError;
    });
  }
  if (!isRecord(info) || typeof info.version !== 'string') throw new Error('OpenCode returned invalid server info');
  return info.version;
}

export async function getOpenCodeMigrationStatus(connection: OpenCodeConnection): Promise<OpenCodeMigration> {
  let value: unknown;
  try {
    value = await requestOpenCode(connection, '/api/experimental/migration/v1', { timeoutMs: 10000 });
  } catch (error) {
    if (error instanceof OpenCodeHttpError && error.status === 404) return { status: 'done' };
    throw error;
  }
  if (!isRecord(value)) return { status: 'done' };
  if (value.status === 'running' || value.status === 'required') return { status: 'pending' };
  if (value.status === 'error') {
    return { status: 'failed', error: typeof value.error === 'string' ? value.error : 'unknown error' };
  }
  return { status: 'done' };
}

export async function createOpenCodeConversation(connection: OpenCodeConnection, title: string): Promise<string> {
  const created = await requestOpenCode(connection, '/api/session', {
    body: { title, location: { directory: connection.workingDir } },
    timeoutMs: 20000,
  });
  return parseConversation(readData(created)).id;
}

export async function getOpenCodeConversation(connection: OpenCodeConnection, id: string): Promise<OpenCodeConversation> {
  validateOpenCodeSessionId(id);
  const conversation = parseConversation(readData(await requestOpenCode(connection, `/api/session/${id}`)));
  if (conversation.id !== id) throw new Error('OpenCode returned a different conversation than requested');
  return conversation;
}

export async function getOpenCodeState(connection: OpenCodeConnection, sessionId: string): Promise<SessionState> {
  validateOpenCodeSessionId(sessionId);
  const query = locationQuery(connection);
  const [active, permissions, forms] = (await Promise.all([
    requestOpenCode(connection, '/api/session/active'),
    requestOpenCode(connection, '/api/permission/request', { query }),
    requestOpenCode(connection, '/api/form', { query }),
  ])).map(readData);
  if (!isRecord(active) || !Array.isArray(permissions) || !Array.isArray(forms)) {
    throw new Error('OpenCode returned invalid session status');
  }
  const busy = Object.entries(active).map(([id, status]) => {
    validateOpenCodeSessionId(id);
    if (!isRecord(status) || status.type !== 'running') {
      throw new Error('OpenCode returned an unknown session status');
    }
    return id;
  });
  const waiting = [...permissions, ...forms].map((request: unknown) => {
    if (!isRecord(request)) throw new Error('OpenCode returned an invalid input request');
    return validateOpenCodeSessionId(request.sessionID);
  });
  const membership = new Map<string, boolean>([[sessionId, true]]);
  const belongsToConversation = async (id: string): Promise<boolean> => {
    const visited = new Set<string>();
    let current: string | undefined = id;
    while (current && !membership.has(current)) {
      if (visited.has(current) || visited.size >= 64) {
        throw new Error('OpenCode returned invalid conversation ancestry');
      }
      visited.add(current);
      current = (await getOpenCodeConversation(connection, current)).parentID;
    }
    const belongs = current !== undefined && membership.get(current) === true;
    for (const member of visited) membership.set(member, belongs);
    return belongs;
  };
  for (const id of new Set(waiting)) {
    if (await belongsToConversation(id)) return 'awaiting';
  }
  for (const id of busy) {
    if (await belongsToConversation(id)) return 'running';
  }
  return 'idle';
}
