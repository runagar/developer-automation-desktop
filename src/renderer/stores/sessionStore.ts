import { create } from 'zustand';
import { Session, SessionState, JiraIssue } from '../../main/types';

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
}));

/** Initialise session store from main process on mount. */
export async function initSessionStore(): Promise<void> {
  const sessions = await window.agentSmith.getSessions();
  const { setSessions, setActiveSessionId } = useSessionStore.getState();
  setSessions(sessions);
  const firstActive = sessions.find((s) => !s.archived);
  if (firstActive) setActiveSessionId(firstActive.id);
}

/** Register IPC listeners that update the session store. */
export function registerSessionListeners(): () => void {
  const { updateSession } = useSessionStore.getState();

  const unsubState = window.agentSmith.onSessionStateChange((id: string, state: SessionState) => {
    updateSession(id, { state });
  });

  const unsubDied = window.agentSmith.onSessionDied((id: string) => {
    updateSession(id, { dead: true, state: 'idle' as SessionState });
  });

  const unsubArchived = window.agentSmith.onSessionArchived((id: string) => {
    const store = useSessionStore.getState();
    updateSession(id, { archived: true });
    if (store.activeSessionId === id) {
      const next = store.sessions.find((s) => s.id !== id && !s.archived);
      useSessionStore.getState().setActiveSessionId(next?.id ?? null);
    }
  });

  return () => {
    unsubState();
    unsubDied();
    unsubArchived();
  };
}
