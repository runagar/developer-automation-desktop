import React, { useEffect, useState, useCallback } from 'react';
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
      setSessions((prev) => prev.filter((s) => s.id !== id));
      setActiveSessionId((prev) => {
        if (prev !== id) return prev;
        const remaining = sessions.filter((s) => s.id !== id);
        return remaining.length > 0 ? remaining[0].id : null;
      });
    },
    [sessions]
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
            />
          ))}
        </main>
      </div>
    </div>
  );
}
