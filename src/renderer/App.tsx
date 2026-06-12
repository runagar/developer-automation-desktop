import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Session, ProjectEntry, ProjectGroup, JiraIssue } from '../main/types';
import SessionList, { SessionListHandle } from './components/SessionList';
import TerminalPane, { TerminalPaneHandle } from './components/TerminalPane';
import { JiraPane, JiraPaneHandle } from './components/JiraPane';
import Workspace from './components/Workspace';
import PanelMenu from './components/PanelMenu';
import ThemeSelector from './components/ThemeSelector';
import TitleBar from './components/TitleBar';
import ZoomControl from './components/ZoomControl';
import { useDashboardLayout } from './dashboard/useDashboardLayout';
import { PanelId } from './dashboard/layout';
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

  // Dashboard panel layout controller (grid placement, visibility, presets, persistence)
  const dashboard = useDashboardLayout();

  // Always-current ref so handlers don't need to re-register on every change.
  const sessionsRef = useRef<Session[]>([]);
  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);

  const activeSessionIdRef = useRef<string | null>(null);
  useEffect(() => { activeSessionIdRef.current = activeSessionId; }, [activeSessionId]);

  // Ref populated by SessionList; called by the Ctrl+N handler below.
  const openDropdownWithKeyboardRef = useRef<() => void>(() => {});

  // Panel focus refs — used by the Workspace's Ctrl+Tab entry points.
  const sessionListRef = useRef<SessionListHandle>(null);
  const terminalRefs = useRef<Map<string, TerminalPaneHandle>>(new Map());
  const jiraRefs = useRef<Map<string, JiraPaneHandle>>(new Map());

  // Mirror the dashboard controller in a ref so stable callbacks can read the
  // current layout/visibility without taking it as a dependency.
  const dashboardRef = useRef(dashboard);
  dashboardRef.current = dashboard;

  // Focus the terminal panel for a given session, if the panel is visible.
  const focusTerminal = useCallback((id: string) => {
    const d = dashboardRef.current;
    if (!d.layout.terminal.visible) return;
    d.bringToFront('terminal');
    terminalRefs.current.get(id)?.focus();
  }, []);

  // Per-session "attach generation". Bumping it changes a TerminalPane's React
  // key, forcing a fresh xterm to mount. This is used on reattach (unarchive /
  // revive) so tmux's repaint lands on a clean terminal instead of colliding
  // with the preserved buffer (which caused duplicated/garbled output).
  const [attachGen, setAttachGen] = useState<Map<string, number>>(new Map());
  const bumpAttachGen = useCallback((id: string) => {
    setAttachGen((prev) => {
      const next = new Map(prev);
      next.set(id, (prev.get(id) ?? 0) + 1);
      return next;
    });
  }, []);
  // Give a freshly-mounted TerminalPane time to subscribe to pty:data before
  // the main process reattaches and streams tmux's repaint.
  const waitForRemount = () => new Promise<void>((res) => setTimeout(res, 60));

  // Note: plain Tab session-cycling is removed. Session switching is now the
  // Sessions panel's intra-panel focus cycle (focus-gated). Cross-panel movement
  // is Ctrl+Tab, handled inside Workspace.

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
      // Move focus into the new session's terminal (if the panel is visible).
      // Wait for the TerminalPane to mount and open before focusing.
      setTimeout(() => focusTerminal(session.id), 80);
    },
    [focusTerminal]
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
      // Mount a fresh xterm and make the session active/visible. Once it has
      // fit to the panel, reattach at exactly that size so tmux paints correctly
      // with no post-attach resize (which would corrupt the display).
      bumpAttachGen(id);
      setSessions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, archived: false, dead: false } : s))
      );
      setActiveSessionId(id);
      await waitForRemount();
      const size = terminalRefs.current.get(id)?.fitAndMeasure() ?? null;
      await window.agentSmith.unarchiveSession(id, size?.cols, size?.rows);
    },
    [bumpAttachGen]
  );

  const handleReviveSession = useCallback(async (id: string) => {
    bumpAttachGen(id);
    setSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, dead: false, state: 'idle' } : s))
    );
    setActiveSessionId(id);
    await waitForRemount();
    const size = terminalRefs.current.get(id)?.fitAndMeasure() ?? null;
    await window.agentSmith.reviveSession(id, size?.cols, size?.rows);
  }, [bumpAttachGen]);

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
    window.agentSmith.ptyWrite(sessionId, `Plan ${key}\r`);
  }, []);

  // --- Jira auto-detect ---
  const jiraKeyBuffer = useRef<Map<string, string>>(new Map());
  const jiraKeyCache = useRef<Map<string, Set<string>>>(new Map());
  const [autoFetchEnabled, setAutoFetchEnabled] = useState(() => {
    try { return localStorage.getItem('agent-smith-jira-autodetect') !== 'false'; } catch { return true; }
  });
  const autoFetchRef = useRef(autoFetchEnabled);
  autoFetchRef.current = autoFetchEnabled;

  const handleAutoFetchToggle = useCallback(() => {
    setAutoFetchEnabled((v) => {
      const next = !v;
      try { localStorage.setItem('agent-smith-jira-autodetect', String(next)); } catch { /* ok */ }
      return next;
    });
  }, []);

  const handleTerminalInput = useCallback((sessionId: string, data: string) => {
    if (!autoFetchRef.current) return;

    const buf = (jiraKeyBuffer.current.get(sessionId) ?? '') + data;
    jiraKeyBuffer.current.set(sessionId, buf);

    const re = /\b([A-Z][A-Z0-9]+-\d+)\b(?=[\s\r,;:.!?]|$)/g;
    let match;
    while ((match = re.exec(buf)) !== null) {
      const key = match[1];
      const cache = jiraKeyCache.current.get(sessionId) ?? new Set();
      if (cache.has(key)) continue;
      cache.add(key);
      jiraKeyCache.current.set(sessionId, cache);

      window.agentSmith.fetchJiraIssue(key)
        .then((issue) => {
          window.agentSmith.writeToVault(issue);
        })
        .catch(() => {});
    }

    // Keep only trailing partial-key fragment
    const lastBoundary = buf.search(/[A-Z][A-Z0-9]*-?\d*$/);
    jiraKeyBuffer.current.set(sessionId, lastBoundary >= 0 ? buf.slice(lastBoundary) : '');
  }, []);

  // Panel entry-point focus actions for Ctrl+Tab navigation.
  const focusEntry: Record<PanelId, () => void> = {
    sessions: () => sessionListRef.current?.focus(),
    terminal: () => {
      const id = activeSessionIdRef.current;
      if (id) terminalRefs.current.get(id)?.focus();
    },
    jira: () => {
      const id = activeSessionIdRef.current;
      if (id) jiraRefs.current.get(id)?.focus();
    },
  };

  // Move focus to the terminal panel for the active session (if the panel is
  // visible). Invoked when the user presses Enter on a focused session item.
  const handleActivateTerminal = useCallback(() => {
    const id = activeSessionIdRef.current;
    if (id) focusTerminal(id);
  }, [focusTerminal]);

  const bodies: Record<PanelId, React.ReactNode> = {
    sessions: (
      <SessionList
        ref={sessionListRef}
        sessions={sessions}
        activeSessionId={activeSessionId}
        projectGroups={projectGroups}
        onSelect={setActiveSessionId}
        onCreate={handleCreateSession}
        onActivateTerminal={handleActivateTerminal}
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
    ),
    terminal: (
      <div className="workspace-fill">
        {sessions.length === 0 && (
          <div className="app-empty">
            <div className="app-empty__text">NO ACTIVE SESSION</div>
            <div className="app-empty__sub">CREATE A NEW SESSION TO BEGIN</div>
          </div>
        )}
        {sessions.map((s) => (
          <div
            key={s.id}
            className="workspace-slot"
            style={s.id === activeSessionId ? undefined : { display: 'none' }}
          >
            <TerminalPane
              key={`${s.id}:${attachGen.get(s.id) ?? 0}`}
              ref={(h) => { if (h) terminalRefs.current.set(s.id, h); else terminalRefs.current.delete(s.id); }}
              session={s}
              isActive={s.id === activeSessionId}
              onRename={handleRenameSession}
              onTerminalInput={handleTerminalInput}
              openDropdownWithKeyboardRef={openDropdownWithKeyboardRef}
            />
          </div>
        ))}
      </div>
    ),
    jira: (
      <div className="workspace-fill">
        {sessions.length === 0 && (
          <div className="app-empty app-empty--small">
            <div className="app-empty__sub">NO ACTIVE SESSION</div>
          </div>
        )}
        {sessions.map((s) => (
          <div
            key={s.id}
            className="workspace-slot"
            style={s.id === activeSessionId ? undefined : { display: 'none' }}
          >
            <JiraPane
              ref={(h) => { if (h) jiraRefs.current.set(s.id, h); else jiraRefs.current.delete(s.id); }}
              sessionId={s.id}
              issue={jiraIssues.get(s.id) ?? null}
              autoFetchEnabled={autoFetchEnabled}
              onAutoFetchToggle={handleAutoFetchToggle}
              onIssueLoaded={handleJiraIssueLoaded}
              onPlan={handleJiraPlan}
            />
          </div>
        ))}
      </div>
    ),
  };

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
          <PanelMenu controller={dashboard} />
          <ZoomControl />
          <ThemeSelector />
        </div>
      </header>
      <div className="app-body">
        <Workspace controller={dashboard} bodies={bodies} focusEntry={focusEntry} />
      </div>
    </div>
  );
}
