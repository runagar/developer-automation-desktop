/**
 * Warm/cold policy for archived sessions.
 *
 * Pure logic, deliberately free of database, tmux and Electron dependencies so
 * it can be unit tested in isolation.
 */

/** How long an archived session stays warm (tmux alive, instant restore). */
export const ARCHIVE_WARM_MINUTES = 30;
/** Maximum number of simultaneously warm archived sessions. */
export const ARCHIVE_WARM_MAX = 3;

export interface ArchivedRow {
  id: string;
  state: string;
  archived_at: string | null;
}

/**
 * Decide which warm archived sessions should be demoted to cold.
 *
 * `warm` must contain only sessions that are currently warm, ordered
 * newest-archived first — cold sessions must not consume a slot in the cap.
 */
export function selectDemotionCandidates(warm: ArchivedRow[], now: number): string[] {
  const warmMs = ARCHIVE_WARM_MINUTES * 60_000;
  return warm
    .filter((row, index) => {
      // Never interrupt work in progress (shutdown eviction is exempt).
      if (row.state === 'running' || row.state === 'awaiting') return false;
      // Over the cap: rows are newest-first, so anything past it goes cold.
      if (index >= ARCHIVE_WARM_MAX) return true;
      // Archived by a version that predates archived_at — treat as expired.
      if (!row.archived_at) return true;
      const archivedAt = Date.parse(row.archived_at);
      if (!Number.isFinite(archivedAt)) return true;
      return now - archivedAt > warmMs;
    })
    .map((row) => row.id);
}
