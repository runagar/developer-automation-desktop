/**
 * GitHub transport — the only module in DAD that knows the `gh` binary exists.
 *
 * Mirrors `tmux.ts`: a private exec helper plus named primitives, so nothing
 * else in the repo shells out to `gh`. DAD never holds a GitHub token and never
 * issues an HTTP request to github.com itself; `gh` owns the credential.
 */

import { execFile } from 'child_process';

/**
 * A full-PR patch dwarfs Node's 1 MB default, and the failure mode of the
 * default is a truncation *error*, not a short read.
 */
const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024;

/** REST pages are capped at 100 by GitHub for every endpoint DAD calls. */
export const PAGE_SIZE = 100;

/**
 * Page cap for object-shaped REST pagination.
 *
 * Far above any reviewable pull request, and bounded so a server that never
 * shortens a page cannot spin forever.
 */
const MAX_REST_PAGES = 30;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** `gh` is not installed or not on PATH. */
export class GitHubUnavailableError extends Error {
  constructor() {
    super('GitHub CLI not found — install it, or run ./setup.sh from the project root');
    this.name = 'GitHubUnavailableError';
  }
}

/** `gh` is installed but not authenticated, or the token lacks scope. */
export class GitHubAuthError extends Error {
  constructor(detail?: string) {
    super(detail ? `Not authenticated — run: gh auth login\n${detail}` : 'Not authenticated — run: gh auth login');
    this.name = 'GitHubAuthError';
  }
}

/** Rate limited. `resetAt` is epoch ms, or null when it could not be read. */
export class GitHubRateLimitError extends Error {
  readonly resetAt: number | null;
  constructor(resetAt: number | null) {
    const when = resetAt ? new Date(resetAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
    super(when ? `Rate limited — retry at ${when}` : 'Rate limited — retry shortly');
    this.name = 'GitHubRateLimitError';
    this.resetAt = resetAt;
  }
}

/** Anything else `gh` reported. Carries the first line of stderr verbatim. */
export class GitHubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubError';
  }
}

// ---------------------------------------------------------------------------
// Process wrapper
// ---------------------------------------------------------------------------

export interface GhExecOptions {
  stdin?: string;
  maxBuffer?: number;
}

interface GhFailure {
  stderr: string;
  code: string | undefined;
}

/**
 * Run `gh` and resolve its stdout.
 *
 * `stdin` is written to the child when supplied — that is how GraphQL
 * documents and mutation variables are passed, because `-f key=value` cannot
 * express a nested input object at all.
 */
export function ghExec(args: string[], options: GhExecOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'gh',
      args,
      {
        encoding: 'utf-8' as BufferEncoding,
        maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve((stdout as string) ?? '');
          return;
        }
        reject(mapExecError({ stderr: (stderr as string) ?? '', code: (err as NodeJS.ErrnoException).code }));
      }
    );

    if (options.stdin !== undefined) {
      child.stdin?.end(options.stdin);
    }
  });
}

/**
 * Classify a `gh` failure.
 *
 * A 403 is deliberately *not* assumed to be rate limiting: it is also SSO
 * enforcement, an archived repository and a protected branch. Telling the user
 * to wait forty minutes for something that will never succeed is worse than
 * showing them what GitHub said.
 */
function mapExecError(failure: GhFailure): Error {
  if (failure.code === 'ENOENT') return new GitHubUnavailableError();

  const stderr = failure.stderr.trim();
  const lower = stderr.toLowerCase();

  if (
    lower.includes('gh auth login') ||
    lower.includes('authentication required') ||
    lower.includes('requires authentication') ||
    lower.includes('bad credentials') ||
    lower.includes('http 401')
  ) {
    return new GitHubAuthError(firstLine(stderr));
  }

  if (isRateLimitMessage(lower)) {
    // Resolved to a real reset time by `ghRest`/`ghGraphql`, which can afford
    // the extra call; the bare mapper stays synchronous.
    return new GitHubRateLimitError(null);
  }

  return new GitHubError(firstLine(stderr) || 'GitHub request failed');
}

function isRateLimitMessage(lowerStderr: string): boolean {
  return lowerStderr.includes('rate limit') || lowerStderr.includes('secondary rate');
}

function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim().length > 0);
  return line ? line.trim() : '';
}

/**
 * Turn a rate-limit error without a reset time into one that has it.
 *
 * This is a single call made *in reaction to* a 403 — `/rate_limit` is itself
 * exempt from rate limiting, so it always answers — and is not the background
 * polling that the feature plan defers.
 */
async function withResetTime(err: Error): Promise<Error> {
  if (!(err instanceof GitHubRateLimitError) || err.resetAt !== null) return err;
  try {
    const raw = await ghExec(['api', 'rate_limit'], { maxBuffer: 1024 * 1024 });
    const parsed = JSON.parse(raw) as {
      resources?: Record<string, { remaining?: number; reset?: number }>;
    };
    const resources = parsed.resources ?? {};
    // Report the soonest reset among the buckets that are actually exhausted.
    const exhausted = Object.values(resources)
      .filter((r) => typeof r.reset === 'number' && (r.remaining ?? 1) === 0)
      .map((r) => (r.reset as number) * 1000);
    if (exhausted.length === 0) return err;
    return new GitHubRateLimitError(Math.min(...exhausted));
  } catch {
    // The reset time is a nicety; failing to read it must not replace a
    // rate-limit message with a confusing secondary failure.
    return err;
  }
}

// ---------------------------------------------------------------------------
// GraphQL
// ---------------------------------------------------------------------------

interface GraphqlEnvelope<T> {
  data?: T;
  errors?: { message?: string; type?: string }[];
}

/**
 * Execute a GraphQL document.
 *
 * Throws on a non-empty `errors[]` even when the process exits 0: GraphQL
 * reports partial failure with a success status, so trusting the exit code
 * alone silently renders half a pull request.
 */
export async function ghGraphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  let raw: string;
  try {
    raw = await ghExec(['api', 'graphql', '--input', '-'], {
      stdin: JSON.stringify({ query, variables }),
    });
  } catch (err) {
    throw await withResetTime(err as Error);
  }

  let envelope: GraphqlEnvelope<T>;
  try {
    envelope = JSON.parse(raw) as GraphqlEnvelope<T>;
  } catch {
    throw new GitHubError('GitHub returned a malformed GraphQL response');
  }

  if (envelope.errors && envelope.errors.length > 0) {
    const messages = envelope.errors.map((e) => e.message).filter(Boolean);
    if (envelope.errors.some((e) => e.type === 'RATE_LIMITED')) {
      throw await withResetTime(new GitHubRateLimitError(null));
    }
    throw new GitHubError(messages[0] ?? 'GraphQL request failed');
  }

  if (envelope.data === undefined) {
    throw new GitHubError('GitHub returned no data');
  }
  return envelope.data;
}

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------

/** A single REST call, no pagination. */
export async function ghRest<T>(path: string, options: GhExecOptions = {}): Promise<T> {
  let raw: string;
  try {
    raw = await ghExec(['api', path], options);
  } catch (err) {
    throw await withResetTime(err as Error);
  }
  return parseJson<T>(raw);
}

/**
 * A paginated REST call whose payload *is* the array.
 *
 * `--paginate` alone concatenates one JSON document per page, which
 * `JSON.parse` rejects; `--slurp` wraps the pages in an outer array, which is
 * then flattened here.
 */
export async function ghRestPagedArray<T>(path: string, options: GhExecOptions = {}): Promise<T[]> {
  let raw: string;
  try {
    raw = await ghExec(['api', path, '--paginate', '--slurp'], options);
  } catch (err) {
    throw await withResetTime(err as Error);
  }
  const pages = parseJson<T[][]>(raw);
  if (!Array.isArray(pages)) return [];
  return pages.flat();
}

/**
 * A paginated REST call whose payload is an *object* with a nested array.
 *
 * `/commits/{sha}` and `/compare/{a}...{b}` paginate their `files` array while
 * repeating the commit metadata on every page, so slurping yields N copies of
 * the metadata and no merged file list. Pages are therefore walked explicitly
 * and only the selected array is concatenated.
 *
 * Termination is by short page, not by a caller-supplied total: these
 * endpoints report no count for the nested array, so trusting one would stop
 * after the first page and silently cap the diff at 100 files.
 */
export async function ghRestPagedObject<T, K extends keyof T>(
  path: string,
  arrayKey: K,
  options: GhExecOptions = {}
): Promise<{ value: T; truncated: boolean }> {
  const first = await ghRest<T>(pageUrl(path, 1), options);
  const items = asArray(first[arrayKey]);

  let page = 2;
  let truncated = false;
  while (items.length >= PAGE_SIZE * (page - 1)) {
    if (page > MAX_REST_PAGES) {
      truncated = true;
      break;
    }
    const next = await ghRest<T>(pageUrl(path, page), options);
    const nextItems = asArray(next[arrayKey]);
    if (nextItems.length === 0) break;
    items.push(...nextItems);
    page += 1;
  }

  return { value: { ...first, [arrayKey]: items } as T, truncated };
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? [...value] : [];
}

function pageUrl(path: string, page: number): string {
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}per_page=${PAGE_SIZE}&page=${page}`;
}

function parseJson<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new GitHubError('GitHub returned a malformed response');
  }
}

// ---------------------------------------------------------------------------
// Error wording (used at the IPC edge)
// ---------------------------------------------------------------------------

/**
 * The single place a GitHub failure becomes user-facing text.
 *
 * Mirrors `tokenErrorMessage` in `ipc/rest.ts`: the renderer receives a
 * message, never an error class.
 */
export function githubErrorMessage(err: unknown): string {
  if (
    err instanceof GitHubUnavailableError ||
    err instanceof GitHubAuthError ||
    err instanceof GitHubRateLimitError ||
    err instanceof GitHubError
  ) {
    return err.message;
  }
  const message = (err as { message?: unknown } | null)?.message;
  return message ? String(message) : 'GitHub request failed';
}

// ---------------------------------------------------------------------------
// Exported for tests
// ---------------------------------------------------------------------------

export const __test__ = { mapExecError, firstLine, pageUrl };
