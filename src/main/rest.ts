import { joinPath } from './apidocs';
import {
  DEFAULT_ENVIRONMENT_KEY, LOCAL_TOKEN, RestEnvironment,
  environmentTarget, findEnvironment,
} from './environments';
import { getToken, invalidateToken } from './nykAuth';

/** No cancellation, so the ceiling has to be generous but finite. */
const REQUEST_TIMEOUT_MS = 60_000;

/** Guards the renderer against a multi-megabyte body it would choke on. */
export const MAX_BODY_BYTES = 5 * 1024 * 1024;

export interface RestHeader {
  name: string;
  value: string;
}

export interface RestRequest {
  environmentKey: string;
  method: string;
  /** Already substituted and query-appended by the renderer. */
  path: string;
  /** A followed link (R4): used verbatim instead of environment base URL + path. */
  absoluteUrl?: string;
  headers: RestHeader[];
  body: string;
  /** False once the user has hand-edited Authorization — suppresses the retry. */
  autoAuth: boolean;
}

export interface RestResult {
  /** False only for a transport failure, where `error` is set and there is no response. */
  ok: boolean;
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  body: string;
  truncated: boolean;
  durationMs: number;
  url: string;
  method: string;
  error: string | null;
}

/**
 * The bearer value for an environment.
 *
 * `local` never touches OAuth — it has no security host, so routing it through
 * `getToken` would authenticate against nothing and could latch the user's
 * real credentials over an environment that does not use them.
 */
export async function tokenForEnvironment(
  dataDir: string, env: RestEnvironment
): Promise<string> {
  if (env.auth === 'local-basic') return LOCAL_TOKEN;
  return getToken(dataDir, environmentTarget(env));
}

/** Reuses the contract join rule so the sent URL matches the displayed one exactly. */
export function buildUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const [rawPath, ...queryParts] = path.split('?');
  const query = queryParts.length > 0 ? `?${queryParts.join('?')}` : '';
  return `${base}${joinPath('', rawPath)}${query}`;
}

/** Requirement 6.2.6 — a header the user left blank is simply not sent. */
export function usableHeaders(headers: RestHeader[]): RestHeader[] {
  return headers.filter((h) => h.name.trim().length > 0 && h.value.trim().length > 0);
}

export function truncateBody(body: string): { body: string; truncated: boolean } {
  if (body.length <= MAX_BODY_BYTES) return { body, truncated: false };
  return { body: body.slice(0, MAX_BODY_BYTES), truncated: true };
}

function isAuthorization(name: string): boolean {
  return name.trim().toLowerCase() === 'authorization';
}

/** The token actually sent, so the retry invalidates the right cache entry. */
export function bearerOf(headers: RestHeader[]): string | null {
  const header = headers.find((h) => isAuthorization(h.name));
  const match = header ? /^\s*Bearer\s+(\S+)\s*$/i.exec(header.value) : null;
  return match ? match[1] : null;
}

export function withBearer(headers: RestHeader[], token: string): RestHeader[] {
  return headers.map((h) => (isAuthorization(h.name) ? { ...h, value: `Bearer ${token}` } : h));
}

function messageOf(err: unknown): string {
  const error = err as any;
  if (error?.name === 'TimeoutError') {
    return `Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`;
  }
  return error?.message ? String(error.message) : 'Request failed';
}

function headerEntries(headers: Headers): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  headers.forEach((value, name) => out.push([name, value]));
  return out;
}

/** `fetch` rejects a body on these outright, so it is simply not attached. */
const BODYLESS_METHODS = ['GET', 'HEAD'];

/** Loopback cannot be intercepted off-machine, so plaintext there is not a leak. */
function isLoopback(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost';
}

/**
 * Whether the bearer token may be attached to this URL.
 *
 * A followed link is any absolute URL found in a response body, and the token
 * is minted from the user's real domain credentials. Sending it over plaintext
 * `http:` would put it on the wire in the clear — the same leak R2's
 * `safeHref` exists to prevent. The host is deliberately *not* checked: a
 * foreign host still gets the token by decision, but never unencrypted.
 */
export function mayAttachToken(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || isLoopback(parsed.hostname);
  } catch {
    return false;
  }
}

/** True when a followed link leaves the selected environment's host. */
export function isForeignHost(url: string, baseUrl: string): boolean {
  try {
    return new URL(url).host !== new URL(baseUrl).host;
  } catch {
    return true;
  }
}

/**
 * Execute a crafted request.
 *
 * Deliberately does not use `withToken`: that helper throws on every non-2xx
 * and turns 403 into a configuration error, which is right for api-docs and
 * wrong here. A 401, 403, 404 or 500 from the target API is a legitimate
 * result the user needs to read, so every status is returned verbatim.
 */
export async function executeRequest(dataDir: string, req: RestRequest): Promise<RestResult> {
  const env = findEnvironment(req.environmentKey)
    ?? findEnvironment(DEFAULT_ENVIRONMENT_KEY)!;
  const url = req.absoluteUrl ?? buildUrl(env.baseUrl, req.path);
  const method = req.method.toUpperCase();
  const started = Date.now();

  const withToken = mayAttachToken(url);
  // Re-minting cannot fix an audience mismatch, and invalidating would discard
  // the token the Crafter is still using. So a link that leaves the selected
  // environment never triggers a re-authentication.
  const autoAuth = req.autoAuth
    && !(req.absoluteUrl !== undefined && isForeignHost(url, env.baseUrl));

  const send = (headers: RestHeader[]): Promise<Response> => {
    const map: Record<string, string> = {};
    for (const header of usableHeaders(headers)) {
      if (!withToken && isAuthorization(header.name)) continue;
      map[header.name.trim()] = header.value;
    }
    return fetch(url, {
      method,
      headers: map,
      // Otherwise sent exactly as typed — an invalid body is a legitimate
      // thing to test against an API.
      body: req.body.length > 0 && !BODYLESS_METHODS.includes(method) ? req.body : undefined,
      // A 302 is a result worth seeing, not something to follow silently.
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  };

  try {
    let headers = req.headers;
    let response = await send(headers);

    // An expired cached token is the common cause of a 401, and it is only
    // worth retrying when DAD minted the token itself. A second 401 is
    // returned as the real answer, and a 403 (valid token, wrong client) never
    // retries because retrying cannot fix it.
    if (response.status === 401 && autoAuth && env.auth === 'oauth') {
      const used = bearerOf(headers);
      if (used) invalidateToken(environmentTarget(env), used);
      const fresh = await tokenForEnvironment(dataDir, env).catch(() => null);
      if (fresh && fresh !== used) {
        headers = withBearer(headers, fresh);
        response = await send(headers);
      }
    }

    const { body, truncated } = truncateBody(await response.text());
    return {
      ok: true,
      status: response.status,
      statusText: response.statusText,
      headers: headerEntries(response.headers),
      body, truncated,
      durationMs: Date.now() - started,
      url, method, error: null,
    };
  } catch (err) {
    // Transport failures (DNS, TLS, timeout, token acquisition) are returned
    // rather than thrown, so the Response panel has one delivery path.
    return {
      ok: false, status: 0, statusText: '', headers: [], body: '', truncated: false,
      durationMs: Date.now() - started, url, method, error: messageOf(err),
    };
  }
}
