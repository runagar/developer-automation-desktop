import { describe, it, expect, vi } from 'vitest';
import { FAILURE_BACKOFF_MS, createRefresher } from './jiraRefresh';
import { JiraIssue } from './types';
import { VaultNoteMeta } from './vaultFreshness';

const NOW = Date.parse('2026-09-10T12:00:00.000Z');

function issue(key: string, statusCategory = 'indeterminate'): JiraIssue {
  return {
    key, summary: `${key} summary`, description: '', status: 'In Progress',
    statusCategory, priority: '', issueType: 'Story', assignee: null, reporter: null,
    labels: [], fixVersions: [], components: [], parentKey: null, linkedIssues: [],
  };
}

function note(key: string, meta: Partial<VaultNoteMeta> = {}) {
  return {
    issue: issue(key),
    meta: {
      statusCategory: meta.statusCategory ?? 'indeterminate',
      fetched: meta.fetched ?? new Date(NOW).toISOString(),
    },
  };
}

/** Build a refresher with stubbed I/O and a frozen clock. */
function harness(overrides: {
  fetchIssue?: (key: string) => Promise<JiraIssue>;
  readNote?: (key: string) => Promise<{ issue: JiraIssue; meta: VaultNoteMeta } | null>;
  now?: () => number;
} = {}) {
  const written: JiraIssue[] = [];
  const fetchIssue = vi.fn(overrides.fetchIssue ?? (async (key: string) => issue(key)));
  const readNote = vi.fn(overrides.readNote ?? (async () => null));
  const refresher = createRefresher({
    fetchIssue,
    readNote,
    writeNote: (i) => { written.push(i); },
    now: overrides.now ?? (() => NOW),
  });
  return { refresher, fetchIssue, readNote, written };
}

describe('createRefresher', () => {
  it('fetches and writes when there is no note', async () => {
    const { refresher, written } = harness();
    const outcome = await refresher.resolve('NRPAV-1');
    expect(outcome.status).toBe('refreshed');
    expect(written.map((i) => i.key)).toEqual(['NRPAV-1']);
  });

  it('skips a fresh note when tiered', async () => {
    const { refresher, fetchIssue, written } = harness({
      readNote: async (key) => note(key),
    });
    const outcome = await refresher.resolve('NRPAV-1', { tiered: true });
    expect(outcome.status).toBe('fresh');
    expect(fetchIssue).not.toHaveBeenCalled();
    expect(written).toHaveLength(0);
  });

  it('refetches a fresh note when not tiered (the primary)', async () => {
    const { refresher, fetchIssue } = harness({ readNote: async (key) => note(key) });
    const outcome = await refresher.resolve('NRPAV-1', { tiered: false });
    expect(outcome.status).toBe('refreshed');
    expect(fetchIssue).toHaveBeenCalledOnce();
  });

  it('refetches a stale note when tiered', async () => {
    const stale = new Date(NOW - 9 * 60 * 60_000).toISOString();
    const { refresher, fetchIssue } = harness({
      readNote: async (key) => note(key, { fetched: stale }),
    });
    const outcome = await refresher.resolve('NRPAV-1', { tiered: true });
    expect(outcome.status).toBe('refreshed');
    expect(fetchIssue).toHaveBeenCalledOnce();
  });

  it('coalesces concurrent calls for the same key into one fetch', async () => {
    const { refresher, fetchIssue } = harness();
    const [a, b, c] = await Promise.all([
      refresher.resolve('NRPAV-1'),
      refresher.resolve('NRPAV-1'),
      refresher.resolve('NRPAV-1'),
    ]);
    expect(fetchIssue).toHaveBeenCalledOnce();
    expect([a.status, b.status, c.status]).toEqual(['refreshed', 'refreshed', 'refreshed']);
  });

  it('does not coalesce different keys', async () => {
    const { refresher, fetchIssue } = harness();
    await Promise.all([refresher.resolve('NRPAV-1'), refresher.resolve('NRPAV-2')]);
    expect(fetchIssue).toHaveBeenCalledTimes(2);
  });

  it('serves the cached note when the fetch fails and never blanks it', async () => {
    const { refresher, written } = harness({
      fetchIssue: async () => { throw new Error('offline'); },
      readNote: async (key) => note(key, { fetched: new Date(NOW - 9 * 60 * 60_000).toISOString() }),
    });
    const outcome = await refresher.resolve('NRPAV-1');
    expect(outcome.status).toBe('failed');
    expect(outcome.issue?.key).toBe('NRPAV-1');
    expect(written).toHaveLength(0);
  });

  it('reports failure with no issue when nothing is cached', async () => {
    const { refresher } = harness({
      fetchIssue: async () => { throw new Error('offline'); },
    });
    const outcome = await refresher.resolve('NRPAV-1');
    expect(outcome.status).toBe('failed');
    expect(outcome.issue).toBeNull();
  });

  it('suppresses a retry inside the failure backoff', async () => {
    let clock = NOW;
    const { refresher, fetchIssue } = harness({
      fetchIssue: async () => { throw new Error('offline'); },
      now: () => clock,
    });
    await refresher.resolve('NRPAV-1');
    clock += 60_000;
    await refresher.resolve('NRPAV-1');
    expect(fetchIssue).toHaveBeenCalledOnce();
  });

  it('retries once the failure backoff expires', async () => {
    let clock = NOW;
    const { refresher, fetchIssue } = harness({
      fetchIssue: async () => { throw new Error('offline'); },
      now: () => clock,
    });
    await refresher.resolve('NRPAV-1');
    clock += FAILURE_BACKOFF_MS + 1;
    await refresher.resolve('NRPAV-1');
    expect(fetchIssue).toHaveBeenCalledTimes(2);
  });

  it('force refetches even when the note is fresh', async () => {
    const { refresher, fetchIssue } = harness({ readNote: async (key) => note(key) });
    const outcome = await refresher.resolve('NRPAV-1', { tiered: true, force: true });
    expect(outcome.status).toBe('refreshed');
    expect(fetchIssue).toHaveBeenCalledOnce();
  });

  it('force bypasses the failure backoff', async () => {
    let clock = NOW;
    let fail = true;
    const { refresher, fetchIssue } = harness({
      fetchIssue: async (key) => {
        if (fail) throw new Error('offline');
        return issue(key);
      },
      now: () => clock,
    });
    await refresher.resolve('NRPAV-1');
    fail = false;
    clock += 1_000;
    const outcome = await refresher.resolve('NRPAV-1', { force: true });
    expect(outcome.status).toBe('refreshed');
    expect(fetchIssue).toHaveBeenCalledTimes(2);
  });

  it('a forced call does not adopt a queued non-forced result', async () => {
    // Otherwise the manual FETCH button silently becomes a cache hit whenever
    // auto-detect happens to be resolving the same key.
    const { refresher, fetchIssue } = harness({ readNote: async (key) => note(key) });
    const [tiered, forced] = await Promise.all([
      refresher.resolve('NRPAV-1', { tiered: true }),
      refresher.resolve('NRPAV-1', { tiered: true, force: true }),
    ]);
    expect(tiered.status).toBe('fresh');
    expect(forced.status).toBe('refreshed');
    expect(fetchIssue).toHaveBeenCalledOnce();
  });

  it('clears a recorded failure after a success', async () => {
    let clock = NOW;
    let fail = true;
    const { refresher, fetchIssue } = harness({
      fetchIssue: async (key) => {
        if (fail) throw new Error('offline');
        return issue(key);
      },
      now: () => clock,
    });
    await refresher.resolve('NRPAV-1');
    fail = false;
    clock += FAILURE_BACKOFF_MS + 1;
    await refresher.resolve('NRPAV-1');
    clock += 1_000;
    await refresher.resolve('NRPAV-1');
    expect(fetchIssue).toHaveBeenCalledTimes(3);
  });
});
