import { create } from 'zustand';
import { JiraIssue } from '../../main/types';

interface JiraStore {
  /** Issues keyed by panelInstanceId (not sessionId). */
  issues: Map<string, JiraIssue>;
  autoFetchEnabled: boolean;

  setIssue: (panelInstanceId: string, issue: JiraIssue) => void;
  clearIssue: (panelInstanceId: string) => void;
  toggleAutoFetch: () => void;
  handleTerminalInput: (sessionId: string, data: string) => void;
  cleanupSession: (sessionId: string) => void;
}

// Internal state not exposed as reactive — kept in closure
const keyBuffer = new Map<string, string>();

/**
 * Burst suppression, deliberately NOT a freshness policy.
 *
 * Auto-detect is fed by terminal *output*, so one tmux repaint (attach, resize,
 * maximize) re-emits every key on screen at once. This absorbs that. Freshness
 * is decided in the main process against the vault.
 *
 * Global rather than per-session: the same key on two terminals is the same
 * repaint problem, and main already guarantees cross-session correctness.
 */
const recentKeys = new Map<string, number>();
const SUPPRESS_MS = 60_000;

// Hoisted regex — avoids recompilation on every keystroke
const JIRA_KEY_RE = /\b([A-Z][A-Z0-9]+-\d+)\b(?=[\s\r,;:.!?]|$)/g;

function loadAutoFetch(): boolean {
  try {
    return localStorage.getItem('dad-jira-autodetect') !== 'false';
  } catch {
    return true;
  }
}

export const useJiraStore = create<JiraStore>((set, get) => ({
  issues: new Map(),
  autoFetchEnabled: loadAutoFetch(),

  setIssue: (panelInstanceId, issue) => {
    set((s) => {
      const next = new Map(s.issues);
      next.set(panelInstanceId, issue);
      return { issues: next };
    });
  },

  clearIssue: (panelInstanceId) => {
    set((s) => {
      const next = new Map(s.issues);
      next.delete(panelInstanceId);
      return { issues: next };
    });
  },

  toggleAutoFetch: () => {
    set((s) => {
      const next = !s.autoFetchEnabled;
      try {
        localStorage.setItem('dad-jira-autodetect', String(next));
      } catch { /* ok */ }
      return { autoFetchEnabled: next };
    });
  },

  handleTerminalInput: (sessionId, data) => {
    if (!get().autoFetchEnabled) return;

    const buf = (keyBuffer.get(sessionId) ?? '') + data;
    keyBuffer.set(sessionId, buf);

    const now = Date.now();
    // Prune here rather than on a timer — the map only grows on detection.
    for (const [k, seenAt] of recentKeys) {
      if (now - seenAt > SUPPRESS_MS) recentKeys.delete(k);
    }

    JIRA_KEY_RE.lastIndex = 0;
    let match;
    while ((match = JIRA_KEY_RE.exec(buf)) !== null) {
      const key = match[1];
      if (recentKeys.has(key)) continue;
      recentKeys.set(key, now);

      window.dad.fetchAndPopulateVault(key)
        .catch(() => {});
    }

    // Keep only trailing partial-key fragment
    const lastBoundary = buf.search(/[A-Z][A-Z0-9]*-?\d*$/);
    keyBuffer.set(sessionId, lastBoundary >= 0 ? buf.slice(lastBoundary) : '');
  },

  cleanupSession: (sessionId) => {
    // Only the buffer is per-session. `recentKeys` is global and must survive:
    // clearing it here would let a repaint in another session refetch at once.
    keyBuffer.delete(sessionId);
  },
}));

/** Pre-populate Jira issues from cached session data, keyed by panel instance ID. */
export function initJiraStore(
  sessions: Array<{ id: string; jiraData?: JiraIssue | null }>,
  getDefaultPanelId: (sessionId: string) => string | undefined
): void {
  const { setIssue } = useJiraStore.getState();
  for (const sess of sessions) {
    if (sess.jiraData) {
      const panelId = getDefaultPanelId(sess.id);
      if (panelId) setIssue(panelId, sess.jiraData);
    }
  }
}
