import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Session, ProjectEntry, ProjectGroup, JiraIssue } from '../main/types';
import SessionList from './components/SessionList';
import TerminalPane from './components/TerminalPane';
import ThemeSelector from './components/ThemeSelector';
import TitleBar from './components/TitleBar';
import ZoomControl from './components/ZoomControl';
import { JiraPane } from './components/JiraPane';
import './styles/app.css';

declare global {
  interface Window {
    agentSmith: import('../main/types').IpcApi;
  }
}

export default function App(): React.ReactElement {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [projectGroups, setProjectGroups] = useState<ProjectGroup[]>([]);
  const [jiraIssues, setJiraIssues] = useState<Map<string, JiraIssue>>(new Map());
  const [jiraCollapsed, setJiraCollapsed] = useState(false);

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
  // Archived sessions are excluded from cycling.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const activeSessions = sessionsRef.current.filter((s) => !s.archived);
      if (activeSessions.length < 2) return;
      e.preventDefault();
      setActiveSessionId((current) => {
        const idx = activeSessions.findIndex((sess) => sess.id === current);
        if (idx === -1) return current;
        const next = e.shiftKey
          ? (idx - 1 + activeSessions.length) % activeSessions.length
          : (idx + 1) % activeSessions.length;
        return activeSessions[next].id;
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
      const firstActive = s.find((sess) => !sess.archived);
      if (firstActive) setActiveSessionId(firstActive.id);
      const map = new Map<string, JiraIssue>();
      for (const sess of s) {
        if (sess.jiraData) map.set(sess.id, sess.jiraData);
      }
      setJiraIssues(map);
    });
    window.agentSmith.getProjectGroups().then(setProjectGroups);

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

    const unsubArchived = window.agentSmith.onSessionArchived((id) => {
      setSessions((prev) => {
        const next = prev.map((s) => (s.id === id ? { ...s, archived: true } : s));
        // If the archived session was active, switch to first non-archived session
        setActiveSessionId((current) => {
          if (current !== id) return current;
          const firstActive = next.find((s) => !s.archived);
          return firstActive?.id ?? null;
        });
        return next;
      });
    });

    return () => {
      unsubState();
      unsubDied();
      unsubArchived();
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
      setSessions((prev) => {
        const next = prev.filter((s) => s.id !== id);
        setActiveSessionId((activeId) =>
          activeId === id ? (next.find((s) => !s.archived)?.id ?? null) : activeId
        );
        return next;
      });
    },
    []
  );

  const handleArchiveSession = useCallback(
    async (id: string) => {
      await window.agentSmith.archiveSession(id);
    },
    []
  );

  const handleUnarchiveSession = useCallback(
    async (id: string) => {
      await window.agentSmith.unarchiveSession(id);
      setSessions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, archived: false, dead: false } : s))
      );
      setActiveSessionId(id);
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

  const refreshProjects = useCallback(() => {
    window.agentSmith.getProjectGroups().then(setProjectGroups);
  }, []);

  const handleAddProject = useCallback(
    async (key: string, repo: string, group: string) => {
      await window.agentSmith.addProject({ key, repo, group });
      refreshProjects();
    },
    [refreshProjects]
  );

  const handleRemoveProject = useCallback(
    async (key: string) => {
      await window.agentSmith.removeProject(key);
      refreshProjects();
    },
    [refreshProjects]
  );

  const handleAddGroup = useCallback(
    async (name: string) => {
      await window.agentSmith.addGroup(name);
      refreshProjects();
    },
    [refreshProjects]
  );

  const handleRemoveGroup = useCallback(
    async (name: string) => {
      await window.agentSmith.removeGroup(name);
      refreshProjects();
    },
    [refreshProjects]
  );

  const handleReorderGroup = useCallback(
    async (name: string, toIndex: number) => {
      await window.agentSmith.reorderGroup(name, toIndex);
      refreshProjects();
    },
    [refreshProjects]
  );

  const handleMoveWorkspace = useCallback(
    async (key: string, toGroup: string, toIndex: number) => {
      await window.agentSmith.moveWorkspace(key, toGroup, toIndex);
      refreshProjects();
    },
    [refreshProjects]
  );

  const handleJiraIssueLoaded = useCallback((sessionId: string, issue: JiraIssue) => {
    setJiraIssues((prev) => new Map(prev).set(sessionId, issue));
  }, []);

  const handleJiraPlan = useCallback((sessionId: string, key: string) => {
    const text = `Fetch ${key} and implement it`;
    let i = 0;
    const typeNext = () => {
      if (i < text.length) {
        window.agentSmith.ptyWrite(sessionId, text[i++]);
        setTimeout(typeNext, 8);
      } else {
        setTimeout(() => window.agentSmith.ptyWrite(sessionId, '\r'), 50);
      }
    };
    typeNext();
  }, []);

  const handleToggleJiraCollapse = useCallback(() => {
    setJiraCollapsed((v) => !v);
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
          projectGroups={projectGroups}
          onSelect={setActiveSessionId}
          onCreate={handleCreateSession}
          onArchive={handleArchiveSession}
          onUnarchive={handleUnarchiveSession}
          onDestroy={handleDestroySession}
          onRevive={handleReviveSession}
          onAddProject={handleAddProject}
          onRemoveProject={handleRemoveProject}
          onAddGroup={handleAddGroup}
          onRemoveGroup={handleRemoveGroup}
          onMoveWorkspace={handleMoveWorkspace}
          onReorderGroup={handleReorderGroup}
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
            <div
              key={s.id}
              className="session-area"
              style={s.id === activeSessionId ? undefined : { display: 'none' }}
            >
              <TerminalPane
                session={s}
                isActive={s.id === activeSessionId}
                onRename={handleRenameSession}
                openDropdownWithKeyboardRef={openDropdownWithKeyboardRef}
              />
              <JiraPane
                sessionId={s.id}
                issue={jiraIssues.get(s.id) ?? null}
                collapsed={jiraCollapsed}
                onToggleCollapse={handleToggleJiraCollapse}
                onIssueLoaded={handleJiraIssueLoaded}
                onPlan={handleJiraPlan}
              />
            </div>
          ))}
        </main>
      </div>
    </div>
  );
}
