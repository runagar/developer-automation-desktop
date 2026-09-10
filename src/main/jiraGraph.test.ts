import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// `jira.ts` reaches app.getPath() when it resolves credentials. Nothing else
// about Electron is used by the traversal.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/dad-test' } }));

import { fetchIssueGraph } from './jira';
import { RefreshOutcome } from './jiraRefresh';
import { JiraIssue, JiraLinkedIssue } from './types';

function issue(
  key: string,
  extra: { linked?: string[]; parentKey?: string | null; issueType?: string } = {}
): JiraIssue {
  const linkedIssues: JiraLinkedIssue[] = (extra.linked ?? []).map((k) => ({
    key: k, summary: '', relation: 'relates to',
  }));
  return {
    key, summary: '', description: '', status: '', statusCategory: 'indeterminate',
    priority: '', issueType: extra.issueType ?? 'Story', assignee: null, reporter: null,
    labels: [], fixVersions: [], components: [],
    parentKey: extra.parentKey ?? null, linkedIssues,
  };
}

const BASE_OPTS = {
  linkedDepth: 1, linkLimit: 8, maxIssues: 30,
  whitelist: [] as string[], maintenanceEpic: 'NRPPRO-326',
};

/**
 * Build a resolve() that returns the given issues and records how it was called.
 * Keys listed in `fresh` are reported as already current; keys in `fail` throw.
 */
function resolver(
  issues: Record<string, JiraIssue>,
  opts: { fresh?: string[]; fail?: string[] } = {}
) {
  const calls: Array<{ key: string; kind: string }> = [];
  const resolve = async (key: string, kind: 'primary' | 'secondary'): Promise<RefreshOutcome> => {
    calls.push({ key, kind });
    if (opts.fail?.includes(key)) {
      return { status: 'failed', issue: null, error: new Error('offline') };
    }
    const found = issues[key] ?? issue(key);
    if (opts.fresh?.includes(key)) return { status: 'fresh', issue: found };
    return { status: 'refreshed', issue: found };
  };
  return { resolve, calls };
}

/** Stub the epic-children JQL call. */
function stubChildKeys(keys: string[] | 'fail') {
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (keys === 'fail') return { ok: false, status: 500, statusText: 'Server Error' };
    return { ok: true, json: async () => ({ issues: keys.map((k) => ({ key: k })) }) };
  }));
}

beforeEach(() => {
  process.env.ATLASSIAN_PAT = 'test-pat';
  process.env.ATLASSIAN_BASE_URL = 'https://jira.example';
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.ATLASSIAN_PAT;
  delete process.env.ATLASSIAN_BASE_URL;
});

describe('fetchIssueGraph', () => {
  it('resolves the primary as a primary and links as secondaries', async () => {
    const { resolve, calls } = resolver({
      'NRPAV-1': issue('NRPAV-1', { linked: ['NRPAV-2'] }),
    });
    const { primary, refreshed } = await fetchIssueGraph('NRPAV-1', { ...BASE_OPTS, resolve });

    expect(primary.key).toBe('NRPAV-1');
    expect(calls).toEqual([
      { key: 'NRPAV-1', kind: 'primary' },
      { key: 'NRPAV-2', kind: 'secondary' },
    ]);
    expect(refreshed).toEqual(['NRPAV-1', 'NRPAV-2']);
  });

  it('throws when the primary fails and nothing is cached', async () => {
    const { resolve } = resolver({}, { fail: ['NRPAV-1'] });
    await expect(fetchIssueGraph('NRPAV-1', { ...BASE_OPTS, resolve })).rejects.toThrow('offline');
  });

  it('keeps going when a linked issue fails', async () => {
    const { resolve, calls } = resolver(
      { 'NRPAV-1': issue('NRPAV-1', { linked: ['NRPAV-2', 'NRPAV-3'] }) },
      { fail: ['NRPAV-2'] }
    );
    const { refreshed } = await fetchIssueGraph('NRPAV-1', { ...BASE_OPTS, resolve });
    expect(calls.map((c) => c.key)).toEqual(['NRPAV-1', 'NRPAV-2', 'NRPAV-3']);
    expect(refreshed).not.toContain('NRPAV-2');
    expect(refreshed).toContain('NRPAV-3');
  });

  it('does not report a fresh secondary as refreshed', async () => {
    const { resolve } = resolver(
      { 'NRPAV-1': issue('NRPAV-1', { linked: ['NRPAV-2'] }) },
      { fresh: ['NRPAV-2'] }
    );
    const { refreshed } = await fetchIssueGraph('NRPAV-1', { ...BASE_OPTS, resolve });
    expect(refreshed).toEqual(['NRPAV-1']);
  });

  it('skips the maintenance epic and non-whitelisted projects', async () => {
    const { resolve, calls } = resolver({
      'NRPAV-1': issue('NRPAV-1', { linked: ['NRPPRO-326', 'XF-9', 'NRPAV-2'] }),
    });
    await fetchIssueGraph('NRPAV-1', { ...BASE_OPTS, whitelist: ['NRPAV'], resolve });
    expect(calls.map((c) => c.key)).toEqual(['NRPAV-1', 'NRPAV-2']);
  });

  it('honours maxIssues', async () => {
    const { resolve, calls } = resolver({
      'NRPAV-1': issue('NRPAV-1', { linked: ['NRPAV-2', 'NRPAV-3', 'NRPAV-4'] }),
    });
    await fetchIssueGraph('NRPAV-1', { ...BASE_OPTS, maxIssues: 3, resolve });
    expect(calls).toHaveLength(3);
  });

  describe('epic children', () => {
    it('discovers children of the parent epic', async () => {
      stubChildKeys(['NRPCON-10', 'NRPCON-11']);
      const { resolve, calls } = resolver({
        'NRPCON-1': issue('NRPCON-1', { parentKey: 'NRPPRO-9' }),
      });
      await fetchIssueGraph('NRPCON-1', { ...BASE_OPTS, resolve });
      expect(calls.map((c) => c.key)).toEqual(['NRPCON-1', 'NRPPRO-9', 'NRPCON-10', 'NRPCON-11']);
    });

    it('still discovers children when the epic was reached through the BFS', async () => {
      // Regression: the old `!visited.has(parentKey)` guard skipped the whole
      // epic block whenever the parent epic was also a linked issue, so
      // children were never discovered.
      stubChildKeys(['NRPCON-10']);
      const { resolve, calls } = resolver({
        'NRPCON-1': issue('NRPCON-1', { linked: ['NRPPRO-9'], parentKey: 'NRPPRO-9' }),
      });
      await fetchIssueGraph('NRPCON-1', { ...BASE_OPTS, resolve });
      expect(calls.map((c) => c.key)).toEqual(['NRPCON-1', 'NRPPRO-9', 'NRPCON-10']);
      // The epic itself is resolved once, by the BFS.
      expect(calls.filter((c) => c.key === 'NRPPRO-9')).toHaveLength(1);
    });

    it('does not discover children when the parent epic is fresh', async () => {
      stubChildKeys(['NRPCON-10']);
      const { resolve, calls } = resolver(
        { 'NRPCON-1': issue('NRPCON-1', { parentKey: 'NRPPRO-9' }) },
        { fresh: ['NRPPRO-9'] }
      );
      await fetchIssueGraph('NRPCON-1', { ...BASE_OPTS, resolve });
      expect(calls.map((c) => c.key)).toEqual(['NRPCON-1', 'NRPPRO-9']);
    });

    it('discovers children when the primary is itself an epic', async () => {
      stubChildKeys(['NRPPRO-10']);
      const { resolve, calls } = resolver({
        'NRPPRO-9': issue('NRPPRO-9', { issueType: 'Epic' }),
      });
      await fetchIssueGraph('NRPPRO-9', { ...BASE_OPTS, resolve });
      expect(calls.map((c) => c.key)).toEqual(['NRPPRO-9', 'NRPPRO-10']);
    });

    it('never discovers children of the maintenance epic', async () => {
      stubChildKeys(['NRPPRO-10']);
      const { resolve, calls } = resolver({
        'NRPPRO-326': issue('NRPPRO-326', { issueType: 'Epic' }),
      });
      await fetchIssueGraph('NRPPRO-326', { ...BASE_OPTS, resolve });
      expect(calls.map((c) => c.key)).toEqual(['NRPPRO-326']);
    });

    it('survives a failed child query without aborting the crawl', async () => {
      stubChildKeys('fail');
      const { resolve, calls } = resolver({
        'NRPCON-1': issue('NRPCON-1', { parentKey: 'NRPPRO-9' }),
      });
      const { primary } = await fetchIssueGraph('NRPCON-1', { ...BASE_OPTS, resolve });
      expect(primary.key).toBe('NRPCON-1');
      expect(calls.map((c) => c.key)).toEqual(['NRPCON-1', 'NRPPRO-9']);
    });

    it('does not re-resolve a child already seen in the BFS', async () => {
      stubChildKeys(['NRPCON-2']);
      const { resolve, calls } = resolver({
        'NRPCON-1': issue('NRPCON-1', { linked: ['NRPCON-2'], parentKey: 'NRPPRO-9' }),
      });
      await fetchIssueGraph('NRPCON-1', { ...BASE_OPTS, resolve });
      expect(calls.filter((c) => c.key === 'NRPCON-2')).toHaveLength(1);
    });
  });
});
