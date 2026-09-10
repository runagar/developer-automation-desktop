/**
 * Refresh coordinator for Jira vault notes.
 *
 * Owns the question "should this key be fetched, and who is fetching it".
 * Every entry point — auto-detect, click-through, the manual FETCH button and
 * the graph traversal — goes through here so one policy applies everywhere.
 *
 * Dependencies are injected so the module can be unit tested without Electron,
 * the filesystem or the network.
 */

import { JiraIssue } from './types';
import { VaultNoteMeta, isStale } from './vaultFreshness';

/** How long a failed key is left alone before another attempt. */
export const FAILURE_BACKOFF_MS = 5 * 60_000;

export type RefreshOutcome =
  /** Fetched from Jira and written to the vault. */
  | { status: 'refreshed'; issue: JiraIssue }
  /** The note was already current; nothing was fetched. */
  | { status: 'fresh'; issue: JiraIssue }
  /** The fetch failed. `issue` is the surviving cached note, if there is one. */
  | { status: 'failed'; issue: JiraIssue | null; error: Error };

export interface RefreshDeps {
  fetchIssue: (key: string) => Promise<JiraIssue>;
  readNote: (key: string) => Promise<{ issue: JiraIssue; meta: VaultNoteMeta } | null>;
  writeNote: (issue: JiraIssue) => void;
  /** Injected for testing; defaults to the wall clock. */
  now?: () => number;
}

export interface RefreshOpts {
  /**
   * Apply the status-category freshness windows. False means the issue is
   * always refetched — used for the primary, which the user named directly.
   */
  tiered?: boolean;
  /** Bypass freshness *and* the failure backoff. The manual FETCH escape hatch. */
  force?: boolean;
}

export interface Refresher {
  resolve: (key: string, opts?: RefreshOpts) => Promise<RefreshOutcome>;
}

export function createRefresher(deps: RefreshDeps): Refresher {
  const now = deps.now ?? (() => Date.now());

  /**
   * Single-flight per issue key, mirroring the token cache in `nykAuth.ts`.
   *
   * The lock spans read -> fetch -> write, not just the HTTP call: without it
   * two panels can both see a stale note, both fetch, and the slower response
   * can land last — overwriting newer content and stamping it fresh. Atomic
   * rename protects against partial files, not against write ordering.
   */
  const inFlight = new Map<string, Promise<RefreshOutcome>>();

  /** Failed keys, held in memory only so the vault stays a record of successes. */
  const failures = new Map<string, { until: number; error: Error }>();

  async function run(key: string, opts: RefreshOpts): Promise<RefreshOutcome> {
    const tiered = opts.tiered ?? true;
    const force = opts.force === true;

    const cached = await deps.readNote(key);

    // Re-checked inside the lock: a queued caller must not refetch what the
    // leader just wrote.
    if (!force && tiered && cached && !isStale(cached.meta, now())) {
      return { status: 'fresh', issue: cached.issue };
    }

    if (!force) {
      const failure = failures.get(key);
      if (failure) {
        if (failure.until > now()) {
          return { status: 'failed', issue: cached?.issue ?? null, error: failure.error };
        }
        failures.delete(key);
      }
    }

    let issue: JiraIssue;
    try {
      issue = await deps.fetchIssue(key);
    } catch (err) {
      const error = err as Error;
      failures.set(key, { until: now() + FAILURE_BACKOFF_MS, error });
      // The existing note survives untouched and is served as-is.
      return { status: 'failed', issue: cached?.issue ?? null, error };
    }

    // A write failure is a real fault (bad path, full disk) and must surface
    // rather than masquerade as an offline fallback.
    deps.writeNote(issue);
    failures.delete(key);
    return { status: 'refreshed', issue };
  }

  return {
    resolve(key, opts = {}) {
      const pending = inFlight.get(key);
      // A forced call must not adopt a queued non-forced result — that would
      // silently turn the manual FETCH escape hatch into a cache hit — but it
      // must still not run concurrently with it.
      if (pending && opts.force !== true) return pending;

      const promise = (async () => {
        if (pending) await pending.catch(() => { /* its caller owns that error */ });
        return run(key, opts);
      })().finally(() => {
        // Only clear the slot if it is still ours; a forced call may have
        // replaced it.
        if (inFlight.get(key) === promise) inFlight.delete(key);
      });

      inFlight.set(key, promise);
      return promise;
    },
  };
}
