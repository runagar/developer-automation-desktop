import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { resolveCredential } from './credentials';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Identifies one OAuth resource: which security host, which client, which callback. */
export interface TokenTarget {
  securityHost: string;
  clientId: string;
  redirectUri: string;
}

export interface Credentials {
  username: string;
  password: string;
}

export type AuthState = 'no-credentials' | 'logged-in' | 'login-failed' | 'unavailable';

/** Discriminates the two very different causes of `unavailable`. */
export type AuthReason = 'rejected' | 'network' | 'configuration' | null;

/** Credentials were actively refused by the authorisation server. Never auto-retry. */
export class CredentialsRejectedError extends Error {
  constructor(message = 'Nykredit credentials were rejected') {
    super(message);
    this.name = 'CredentialsRejectedError';
  }
}

/** The authorisation server could not be reached. Safe to retry later. */
export class AuthUnavailableError extends Error {
  constructor(message = 'Could not reach the Nykredit authorisation server') {
    super(message);
    this.name = 'AuthUnavailableError';
  }
}

/** A valid token was minted but the resource rejected it (wrong client id). Never auto-retry. */
export class AuthConfigurationError extends Error {
  constructor(message = 'Token was rejected by the resource') {
    super(message);
    this.name = 'AuthConfigurationError';
  }
}

const AUTHN_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Rejection latch
//
// A wrong or expired password must never be retried automatically: repeated
// failed authentications against the domain can lock the user's account. The
// latch records which credentials were refused so that no automatic code path
// tries them again until the user logs in successfully.
//
// It lives in its own 0600 file rather than settings.json, which is
// world-readable, and stores a keyed HMAC rather than a bare digest so the
// stored value is not an offline-bruteforceable password verifier.
// ---------------------------------------------------------------------------

interface AuthStateFile {
  installKey: string;
  rejected: string[];
}

const MAX_REJECTED = 10;

let cachedAuthFile: AuthStateFile | null = null;
let cachedAuthDir: string | null = null;

function authStatePath(dataDir: string): string {
  return path.join(dataDir, 'auth-state.json');
}

function writeAuthFile(dataDir: string, file: AuthStateFile): void {
  const filePath = authStatePath(dataDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(file, null, 2), { encoding: 'utf-8', mode: 0o600 });
  // writeFileSync's mode only applies at creation — an existing file keeps its own mode.
  fs.chmodSync(filePath, 0o600);
  cachedAuthFile = file;
  cachedAuthDir = dataDir;
}

function loadAuthFile(dataDir: string): AuthStateFile {
  if (cachedAuthFile && cachedAuthDir === dataDir) return cachedAuthFile;

  const filePath = authStatePath(dataDir);
  if (fs.existsSync(filePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (typeof parsed?.installKey === 'string' && parsed.installKey.length > 0) {
        const file: AuthStateFile = {
          installKey: parsed.installKey,
          rejected: Array.isArray(parsed.rejected)
            ? parsed.rejected.filter((r: unknown): r is string => typeof r === 'string')
            : [],
        };
        cachedAuthFile = file;
        cachedAuthDir = dataDir;
        return file;
      }
    } catch {
      // Corrupt or unreadable — fall through and regenerate. Losing the latch
      // is acceptable; refusing to start is not.
    }
  }

  const fresh: AuthStateFile = { installKey: crypto.randomBytes(32).toString('hex'), rejected: [] };
  writeAuthFile(dataDir, fresh);
  return fresh;
}

/** Stable, non-reversible identifier for one credential pair. */
function credentialId(dataDir: string, creds: Credentials): string {
  const { installKey } = loadAuthFile(dataDir);
  return crypto
    .createHmac('sha256', Buffer.from(installKey, 'hex'))
    .update(`${creds.username}\n${creds.password}`)
    .digest('hex');
}

export function isLatched(dataDir: string, creds: Credentials): boolean {
  if (!creds.username || !creds.password) return false;
  const file = loadAuthFile(dataDir);
  return file.rejected.includes(credentialId(dataDir, creds));
}

/**
 * Record that these credentials were refused.
 *
 * This adds to a set rather than replacing a single value: latching A and then
 * failing with B must not make A automatically retryable again.
 */
export function latchRejected(dataDir: string, creds: Credentials): void {
  if (!creds.username || !creds.password) return;
  const file = loadAuthFile(dataDir);
  const id = credentialId(dataDir, creds);
  if (file.rejected.includes(id)) return;
  const rejected = [...file.rejected, id].slice(-MAX_REJECTED);
  writeAuthFile(dataDir, { ...file, rejected });
}

/** Clear the whole latch. Only a successful manual login may do this. */
export function clearLatch(dataDir: string): void {
  const file = loadAuthFile(dataDir);
  if (file.rejected.length === 0) return;
  writeAuthFile(dataDir, { ...file, rejected: [] });
}

/** Test seam — drops the in-memory mirror of auth-state.json. */
export function clearAuthFileCache(): void {
  cachedAuthFile = null;
  cachedAuthDir = null;
}

// ---------------------------------------------------------------------------
// Redirect parsing
// ---------------------------------------------------------------------------

/**
 * Both success and failure come back as HTTP 302 — the outcome is only in the
 * redirect fragment. Never branch on the status code.
 */
export function parseAuthnRedirect(location: string | null): { token?: string; error?: string } {
  if (!location) return {};
  const hashIdx = location.indexOf('#');
  if (hashIdx === -1) return {};
  const params = new URLSearchParams(location.slice(hashIdx + 1));
  const token = params.get('access_token');
  if (token) return { token };
  const error = params.get('error');
  if (error) return { error };
  return {};
}

/** Fallback for servers that render the redirect as a link instead of a header. */
export function parseAuthnBody(body: string): { token?: string; error?: string } {
  const token = /access_token=([^&"'\s]+)/.exec(body);
  if (token) return { token: token[1] };
  const error = /[#&]error=([^&"'\s]+)/.exec(body);
  if (error) return { error: error[1] };
  return {};
}

// ---------------------------------------------------------------------------
// Token acquisition
// ---------------------------------------------------------------------------

/**
 * Acquire an access token for `target` using the credentials passed in.
 *
 * Credentials are an explicit argument and are never resolved internally: the
 * login dialog must be able to verify values the user just typed and which are
 * deliberately not yet saved.
 */
export async function acquireToken(target: TokenTarget, creds: Credentials): Promise<string> {
  if (!creds.username || !creds.password) {
    throw new CredentialsRejectedError('No Nykredit credentials configured');
  }

  const body = new URLSearchParams({
    response_type: 'token',
    client_id: target.clientId,
    // Hardcoded on purpose. api-docs' config.json advertises `auth.pre_auth`,
    // which is the interactive SSO path DAD deliberately does not use.
    auth_type: 'auth.nyk_username',
    redirect_uri: target.redirectUri,
    state: crypto.randomBytes(8).toString('hex'),
    username: creds.username,
    password: creds.password,
  });

  let response: Response;
  try {
    response = await fetch(`https://${target.securityHost}/security/oauth2/authn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(AUTHN_TIMEOUT_MS),
    });
  } catch (err: any) {
    throw new AuthUnavailableError(
      `Could not reach ${target.securityHost}: ${err?.message ?? 'network error'}`
    );
  }

  let result = parseAuthnRedirect(response.headers.get('location'));
  if (!result.token && !result.error) {
    try {
      result = parseAuthnBody(await response.text());
    } catch {
      // Body unreadable — treated as an unavailable server below.
    }
  }

  if (result.token) return result.token;
  if (result.error) {
    throw new CredentialsRejectedError(
      result.error === 'access_denied'
        ? 'Authentication failed — check your Nykredit initials and password'
        : `Authentication failed: ${result.error}`
    );
  }
  throw new AuthUnavailableError(
    `Unexpected response from ${target.securityHost} (HTTP ${response.status})`
  );
}

// ---------------------------------------------------------------------------
// Cached, single-flight token access
// ---------------------------------------------------------------------------

const tokenCache = new Map<string, string>();
const inFlight = new Map<string, Promise<string>>();

function targetKey(target: TokenTarget): string {
  return `${target.securityHost}|${target.clientId}`;
}

export function readCredentials(dataDir: string): Credentials {
  return {
    username: resolveCredential(dataDir, 'NYK_USERNAME'),
    password: resolveCredential(dataDir, 'NYK_PASSWORD'),
  };
}

/**
 * Token for automatic (non-interactive) callers.
 *
 * Concurrent callers share a single in-flight acquisition. Without that, app
 * startup, selection restore and several simultaneous 401s could each fire an
 * authentication before the first rejection latched — a burst of failed logins
 * is exactly what risks locking the account.
 */
export async function getToken(dataDir: string, target: TokenTarget): Promise<string> {
  const key = targetKey(target);
  const cached = tokenCache.get(key);
  if (cached) return cached;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const creds = readCredentials(dataDir);
  if (!creds.username || !creds.password) {
    throw new CredentialsRejectedError('No Nykredit credentials configured');
  }
  if (isLatched(dataDir, creds)) {
    throw new CredentialsRejectedError(
      'Nykredit credentials were rejected — log in again to retry'
    );
  }

  const promise = acquireToken(target, creds)
    .then((token) => {
      tokenCache.set(key, token);
      return token;
    })
    .catch((err) => {
      if (err instanceof CredentialsRejectedError) latchRejected(dataDir, creds);
      throw err;
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, promise);
  return promise;
}

/**
 * Drop a token that a resource answered 401 for.
 *
 * Only clears the cache if the stale token is still the cached one, so a
 * concurrent request cannot discard a token another caller just minted.
 */
export function invalidateToken(target: TokenTarget, staleToken: string): void {
  const key = targetKey(target);
  if (tokenCache.get(key) === staleToken) tokenCache.delete(key);
}

export function cacheToken(target: TokenTarget, token: string): void {
  tokenCache.set(targetKey(target), token);
}

export function clearTokens(): void {
  tokenCache.clear();
}

/**
 * Run an authenticated request, retrying once if the resource says the token
 * has expired.
 *
 * 401 means "no valid token" and is retried exactly once. 403 means "valid
 * token, wrong client" — retrying can never fix it, so it is surfaced as a
 * configuration error instead.
 */
export async function withToken<T>(
  dataDir: string,
  target: TokenTarget,
  run: (token: string) => Promise<Response>,
  parse: (response: Response) => Promise<T>
): Promise<T> {
  let token = await getToken(dataDir, target);
  let response = await run(token);

  if (response.status === 401) {
    invalidateToken(target, token);
    token = await getToken(dataDir, target);
    response = await run(token);
  }

  if (response.status === 403) {
    throw new AuthConfigurationError(
      'API-docs rejected the token (wrong OAuth client id) — this is a configuration problem, not a password problem'
    );
  }
  if (!response.ok) {
    throw new Error(`Request failed: HTTP ${response.status} ${response.statusText}`);
  }
  return parse(response);
}
