import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Session, ProjectEntry } from '../main/types';
import SessionList from './components/SessionList';
import TerminalPane from './components/TerminalPane';
import ThemeSelector from './components/ThemeSelector';
import TitleBar from './components/TitleBar';
import ZoomControl from './components/ZoomControl';
import './styles/app.css';

declare global {
  interface Window {
    agentSmith: import('../main/types').IpcApi;
  }
}

export default function App(): React.ReactElement {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectEntry[]>([]);

  // Always-current ref so the Tab cycling handler doesn't need to re-register
  // every time the sessions list changes.
  const sessionsRef = useRef<Session[]>([]);
  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);

  // Ref populated by SessionList; called by the Ctrl+N handler below.
  const openDropdownWithKeyboardRef = useRef<() => void>(() => {});

  // Tab / Shift+Tab — cycle forward / backward through sessions.
  // Registered once; reads fresh sessions from sessionsRef.
  // SessionList's dropdown handler uses capture phase + stopImmediatePropagation
  // to suppress this when the dropdown is open.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const s = sessionsRef.current;
      if (s.length < 2) return;
      e.preventDefault();
      setActiveSessionId((current) => {
        const idx = s.findIndex((sess) => sess.id === current);
        if (idx === -1) return current;
        const next = e.shiftKey
          ? (idx - 1 + s.length) % s.length
          : (idx + 1) % s.length;
        return s[next].id;
      });
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  // Ctrl+N — open the New Session dropdown with keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'n' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        openDropdownWithKeyboardRef.current();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => {
    window.agentSmith.getSessions().then((s) => {
      setSessions(s);
      if (s.length > 0) setActiveSessionId(s[0].id);
    });
    window.agentSmith.getProjects().then(setProjects);

    const unsubState = window.agentSmith.onSessionStateChange((id, state) => {
      setSessions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, state } : s))
      );
    });

    const unsubDied = window.agentSmith.onSessionDied((id) => {
      setSessions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, dead: true, state: 'idle' } : s))
      );
    });

    return () => {
      unsubState();
      unsubDied();
    };
  }, []);

  const handleCreateSession = useCallback(
    async (workingDir: string, project?: string) => {
      const session = await window.agentSmith.createSession({ workingDir, project });
      setSessions((prev) => [...prev, session]);
      setActiveSessionId(session.id);
    },
    []
  );

  const handleDestroySession = useCallback(
    async (id: string) => {
      await window.agentSmith.destroySession(id);
      // Use functional updater so `remaining` is derived from fresh state,
      // avoiding the stale-closure bug that occurred when `sessions` was captured.
      setSessions((prev) => {
        const next = prev.filter((s) => s.id !== id);
        setActiveSessionId((activeId) =>
          activeId === id ? (next[0]?.id ?? null) : activeId
        );
        return next;
      });
    },
    []
  );

  const handleReviveSession = useCallback(async (id: string) => {
    await window.agentSmith.reviveSession(id);
    setSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, dead: false, state: 'idle' } : s))
    );
  }, []);

  const handleRenameSession = useCallback(async (id: string, name: string) => {
    await window.agentSmith.renameSession(id, name);
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, name } : s)));
  }, []);

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;

  return (
    <div className="app-shell">
      <div className="crt-glow" aria-hidden="true" />
      <TitleBar />
      <header className="app-header">
        <div className="app-header__logo">
          <span className="app-header__bracket">[</span>
          <span className="app-header__title">AGENT SMITH</span>
          <span className="app-header__bracket">]</span>
        </div>
        <div className="app-header__right">
          <ZoomControl />
          <ThemeSelector />
        </div>
      </header>
      <div className="app-body">
        <SessionList
          sessions={sessions}
          activeSessionId={activeSessionId}
          projects={projects}
          onSelect={setActiveSessionId}
          onCreate={handleCreateSession}
          onDestroy={handleDestroySession}
          onRevive={handleReviveSession}
          openDropdownWithKeyboardRef={openDropdownWithKeyboardRef}
        />
        <main className="app-main">
          {sessions.length === 0 && (
            <div className="app-empty">
              <div className="app-empty__text">NO ACTIVE SESSION</div>
              <div className="app-empty__sub">CREATE A NEW SESSION TO BEGIN</div>
            </div>
          )}
          {sessions.map((s) => (
            <TerminalPane
              key={s.id}
              session={s}
              isActive={s.id === activeSessionId}
              onRename={handleRenameSession}
              openDropdownWithKeyboardRef={openDropdownWithKeyboardRef}
            />
          ))}
        </main>
      </div>
    </div>
  );
}
