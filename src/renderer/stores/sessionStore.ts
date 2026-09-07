import { create } from 'zustand';
import { Session, SessionState, JiraIssue } from '../../main/types';
import { useLayoutStore } from './layoutStore';

interface SessionStore {
  sessions: Session[];
  activeSessionId: string | null;
  attachGen: Map<string, number>;

  setSessions: (sessions: Session[]) => void;
  setActiveSessionId: (id: string | null) => void;
  bumpAttachGen: (id: string) => void;
  updateSession: (id: string, patch: Partial<Session>) => void;
  addSession: (session: Session) => void;
  removeSession: (id: string) => void;
  reorderSessions: (orderedIds: string[]) => void;
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  attachGen: new Map(),

  setSessions: (sessions) => set({ sessions }),

  setActiveSessionId: (id) => set({ activeSessionId: id }),

  bumpAttachGen: (id) => {
    set((s) => {
      const next = new Map(s.attachGen);
      next.set(id, (s.attachGen.get(id) ?? 0) + 1);
      return { attachGen: next };
    });
  },

  updateSession: (id, patch) => {
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === id ? { ...sess, ...patch } : sess
      ),
    }));
  },

  addSession: (session) => {
    set((s) => ({ sessions: [...s.sessions, session] }));
  },

  removeSession: (id) => {
    set((s) => {
      const next = s.sessions.filter((sess) => sess.id !== id);
      const activeSessionId =
        s.activeSessionId === id
          ? (next.find((sess) => !sess.archived)?.id ?? null)
          : s.activeSessionId;
      return { sessions: next, activeSessionId };
    });
  },

  reorderSessions: (orderedIds) => {
    set((s) => {
      const idxMap = new Map(orderedIds.map((id, i) => [id, i]));
      const sorted = [...s.sessions].sort((a, b) => {
        const ai = idxMap.get(a.id) ?? Infinity;
        const bi = idxMap.get(b.id) ?? Infinity;
        return ai - bi;
      });
      return { sessions: sorted };
    });
    void window.dad.reorderSessions(orderedIds);
  },
}));

/** Initialise session store from main process on mount. */
export async function initSessionStore(): Promise<void> {
  const sessions = await window.dad.getSessions();
  const { setSessions, setActiveSessionId } = useSessionStore.getState();
  setSessions(sessions);
  const firstActive = sessions.find((s) => !s.archived);
  if (firstActive) {
    setActiveSessionId(firstActive.id);
    // Sync default panels immediately so the first render with populated
    // sessions already shows the correct session (avoids stale PTY attach).
    useLayoutStore.getState().switchDefaultPanels(firstActive.id);
  }
}

/**
 * Pick which session takes over as active when `archivedId` is archived.
 *
 * `sessions` must be the session list *before* the archive flag is applied.
 * Hands over to the session below the archived one, falling back to the one
 * above when it was last in the list.
 */
export function pickNextActiveSessionId(
  sessions: Session[],
  archivedId: string
): string | null {
  const unarchived = sessions.filter((s) => !s.archived);
  const idx = unarchived.findIndex((s) => s.id === archivedId);
  const next = idx === -1
    ? unarchived.find((s) => s.id !== archivedId)
    : (unarchived[idx + 1] ?? unarchived[idx - 1]);
  return next?.id ?? null;
}

/** Register IPC listeners that update the session store. */
export function registerSessionListeners(): () => void {
  const { updateSession } = useSessionStore.getState();

  const unsubState = window.dad.onSessionStateChange((id: string, state: SessionState) => {
    updateSession(id, { state });
  });

  const unsubDied = window.dad.onSessionDied((id: string) => {
    updateSession(id, { dead: true, state: 'idle' as SessionState });
  });

  const unsubArchived = window.dad.onSessionArchived((id: string) => {
    const store = useSessionStore.getState();
    const wasActive = store.activeSessionId === id;
    // Resolve the successor against the order *before* the archive flag flips.
    const successorId = pickNextActiveSessionId(store.sessions, id);
    updateSession(id, { archived: true, warm: true });
    // Archiving an inactive session must not steal the active selection.
    if (!wasActive) return;
    useSessionStore.getState().setActiveSessionId(successorId);
  });

  const unsubWarmth = window.dad.onSessionsWarmthChanged((warmIds: string[]) => {
    const warm = new Set(warmIds);
    useSessionStore.setState((s) => {
      let changed = false;
      const sessions = s.sessions.map((sess) => {
        if (!sess.archived) return sess;
        const next = warm.has(sess.id);
        if (sess.warm === next) return sess;
        changed = true;
        return { ...sess, warm: next };
      });
      // Returning the same state keeps this a no-op for subscribers, so the
      // main process can safely re-send warmth on every poll tick.
      return changed ? { sessions } : s;
    });
  });

  return () => {
    unsubState();
    unsubDied();
    unsubArchived();
    unsubWarmth();
  };
}
