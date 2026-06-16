import { create } from 'zustand';
import { JiraIssue } from '../../main/types';

interface JiraStore {
  issues: Map<string, JiraIssue>;
  autoFetchEnabled: boolean;

  setIssue: (sessionId: string, issue: JiraIssue) => void;
  clearIssue: (sessionId: string) => void;
  toggleAutoFetch: () => void;
  handleTerminalInput: (sessionId: string, data: string) => void;
}

// Internal state not exposed as reactive — kept in closure
const keyBuffer = new Map<string, string>();
const keyCache = new Map<string, Set<string>>();

function loadAutoFetch(): boolean {
  try {
    return localStorage.getItem('agent-smith-jira-autodetect') !== 'false';
  } catch {
    return true;
  }
}

export const useJiraStore = create<JiraStore>((set, get) => ({
  issues: new Map(),
  autoFetchEnabled: loadAutoFetch(),

  setIssue: (sessionId, issue) => {
    set((s) => {
      const next = new Map(s.issues);
      next.set(sessionId, issue);
      return { issues: next };
    });
  },

  clearIssue: (sessionId) => {
    set((s) => {
      const next = new Map(s.issues);
      next.delete(sessionId);
      return { issues: next };
    });
  },

  toggleAutoFetch: () => {
    set((s) => {
      const next = !s.autoFetchEnabled;
      try {
        localStorage.setItem('agent-smith-jira-autodetect', String(next));
      } catch { /* ok */ }
      return { autoFetchEnabled: next };
    });
  },

  handleTerminalInput: (sessionId, data) => {
    if (!get().autoFetchEnabled) return;

    const buf = (keyBuffer.get(sessionId) ?? '') + data;
    keyBuffer.set(sessionId, buf);

    const re = /\b([A-Z][A-Z0-9]+-\d+)\b(?=[\s\r,;:.!?]|$)/g;
    let match;
    while ((match = re.exec(buf)) !== null) {
      const key = match[1];
      const cache = keyCache.get(sessionId) ?? new Set();
      if (cache.has(key)) continue;
      cache.add(key);
      keyCache.set(sessionId, cache);

      window.agentSmith.fetchJiraIssue(key)
        .then((issue) => {
          window.agentSmith.writeToVault(issue);
        })
        .catch(() => {});
    }

    // Keep only trailing partial-key fragment
    const lastBoundary = buf.search(/[A-Z][A-Z0-9]*-?\d*$/);
    keyBuffer.set(sessionId, lastBoundary >= 0 ? buf.slice(lastBoundary) : '');
  },
}));

/** Pre-populate Jira issues from cached session data. */
export function initJiraStore(sessions: Array<{ id: string; jiraData?: JiraIssue | null }>): void {
  const { setIssue } = useJiraStore.getState();
  for (const sess of sessions) {
    if (sess.jiraData) setIssue(sess.id, sess.jiraData);
  }
}
