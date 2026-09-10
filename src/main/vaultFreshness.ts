/**
 * Freshness policy for Jira vault notes.
 *
 * Pure logic, deliberately free of filesystem, network and Electron
 * dependencies so it can be unit tested in isolation — the same shape as
 * `archivePolicy.ts`.
 *
 * A note's tier is decided by the issue's Jira `statusCategory`, not by its
 * status name: the instance defines 291 distinct status names across only
 * three categories in use, so a hand-maintained name list was never viable.
 */

/** Terminal issues (`Done`, `Closed`) are refetched after 30 days. */
export const TERMINAL_MS = 30 * 24 * 60 * 60 * 1000;
/** Active issues (`In Progress`, `Ready`, `In Specify`, …) are refetched after 8 hours. */
export const ACTIVE_MS = 8 * 60 * 60 * 1000;

/**
 * How far ahead of the local clock a stamp may sit before it is distrusted.
 * A clock briefly set forward while writing would otherwise yield a negative
 * age, which reads as fresh for up to a month after the clock is corrected.
 */
export const FUTURE_TOLERANCE_MS = 60_000;

export type FreshnessTier = 'terminal' | 'active' | 'always';

/** The two vault-note fields the freshness decision depends on. */
export interface VaultNoteMeta {
  /** ISO-8601 with an explicit timezone. Null for notes written before this feature. */
  fetched: string | null;
  /** Jira `statusCategory.key`. Null for notes written before this feature. */
  statusCategory: string | null;
}

/**
 * Jira defines a fourth category key, `undefined` ("No Category"), which is
 * deliberately absent here: a status with no category says nothing about
 * whether the issue is active, so it must land in the always-refetch tier
 * along with everything else unrecognised.
 */
const TIER_BY_CATEGORY: Record<string, FreshnessTier> = {
  done: 'terminal',
  indeterminate: 'active',
  new: 'always',
};

const WINDOW_MS: Record<FreshnessTier, number> = {
  terminal: TERMINAL_MS,
  active: ACTIVE_MS,
  always: 0,
};

/** ISO-8601 must carry `Z` or a numeric offset; `Date.parse` reads anything else as local time. */
const HAS_TIMEZONE = /(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * Map a Jira status category key to its refresh tier.
 *
 * Anything unrecognised — including `undefined`, an empty string, a null and a
 * category Atlassian adds later — resolves to `always`. Guessing `terminal`
 * would hide a stale note for a month with no signal.
 */
export function tierForCategory(category: string | null | undefined): FreshnessTier {
  if (!category) return 'always';
  return TIER_BY_CATEGORY[category.trim().toLowerCase()] ?? 'always';
}

/**
 * Decide whether a vault note needs refetching.
 *
 * A missing note, a missing or unusable `fetched` stamp, and an unrecognised
 * category all count as stale.
 */
export function isStale(meta: VaultNoteMeta | null, now: number): boolean {
  if (!meta) return true;

  const tier = tierForCategory(meta.statusCategory);
  if (tier === 'always') return true;

  const stamp = meta.fetched?.trim();
  // Written by a version that predates this feature — treat as maximally stale.
  if (!stamp || !HAS_TIMEZONE.test(stamp)) return true;

  const fetchedAt = Date.parse(stamp);
  if (!Number.isFinite(fetchedAt)) return true;
  if (fetchedAt - now > FUTURE_TOLERANCE_MS) return true;

  return now - fetchedAt > WINDOW_MS[tier];
}
