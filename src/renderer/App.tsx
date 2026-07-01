import React, { useCallback, useEffect, useRef } from 'react';
import { PanelInstance, PanelType, PANEL_LABELS } from './dashboard/layout';
import SessionList, { SessionListHandle } from './components/SessionList';
import TerminalPanelInstance from './components/TerminalPanelInstance';
import ShellPanelInstance from './components/ShellPanelInstance';
import JiraPanelInstance from './components/JiraPanelInstance';
import { JiraPaneHandle } from './components/JiraPane';
import Workspace from './components/Workspace';
import PanelMenu from './components/PanelMenu';
import ThemeSelector from './components/ThemeSelector';
import TitleBar from './components/TitleBar';
import ZoomControl from './components/ZoomControl';
import { useJiraStore, initJiraStore } from './stores/jiraStore';
import { useLayoutStore } from './stores/layoutStore';
import { useProjectStore } from './stores/projectStore';
import {
  initSessionStore,
  registerSessionListeners,
  useSessionStore,
} from './stores/sessionStore';
import './styles/app.css';

declare global {
  interface Window {
    agentSmith: import('../main/types').IpcApi;
  }
}

export default function App(): React.ReactElement {
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const setActiveSessionId = useSessionStore((s) => s.setActiveSessionId);
  const projectGroups = useProjectStore((s) => s.groups);

  const openDropdownWithKeyboardRef = useRef<() => void>(() => {});
  const sessionListRef = useRef<SessionListHandle>(null);
  const jiraRefs = useRef<Map<string, JiraPaneHandle>>(new Map());

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
    let cancelled = false;
    let cleanup = () => {};

    void (async () => {
      await initSessionStore();
      if (cancelled) return;
      initJiraStore(useSessionStore.getState().sessions, (sessionId) => {
        // Find the default jira panel instance for this session
        const instances = useLayoutStore.getState().instances;
        const defaultJira = instances.find(
          (p: PanelInstance) => p.type === 'jira' && p.mode === 'default'
        );
        return defaultJira?.id;
      });
      cleanup = registerSessionListeners();
      void useProjectStore.getState().loadGroups();
    })();

    return () => {
      cancelled = true;
      cleanup();
    };
  }, []);

  // When activeSessionId changes, switch default panels
  const prevActiveRef = useRef<string | null>(null);
  useEffect(() => {
    if (activeSessionId !== prevActiveRef.current) {
      if (activeSessionId) {
        useLayoutStore.getState().switchDefaultPanels(activeSessionId);
      } else {
        // No active session — clear all default panels' currentSessionId
        useLayoutStore.getState().switchDefaultPanels('');
      }
    }
    prevActiveRef.current = activeSessionId;
  }, [activeSessionId]);

  // OSC52 clipboard handling for PTY data
  useEffect(() => {
    const osc52Re = /\x1b\]52;[cps0-9]*;([A-Za-z0-9+/=]+)(?:\x07|\x1b\\)/g;
    const unsub = window.agentSmith.onPtyData((_panelInstanceId, data) => {
      osc52Re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = osc52Re.exec(data)) !== null) {
        try {
          window.agentSmith.clipboardWrite(atob(match[1]));
        } catch {
          // Ignore invalid base64 clipboard payloads.
        }
      }
    });
    return unsub;
  }, []);

  const handleCreateSession = useCallback(
    async (workingDir: string, project?: string) => {
      const session = await window.agentSmith.createSession({ workingDir, project });
      const store = useSessionStore.getState();
      store.addSession(session);
      store.setActiveSessionId(session.id);
    },
    []
  );

  const handleDestroySession = useCallback(async (id: string) => {
    useLayoutStore.getState().destroyLinkedPanels(id);
    await window.agentSmith.destroySession(id);
    useSessionStore.getState().removeSession(id);
  }, []);

  const handleArchiveSession = useCallback(async (id: string) => {
    useLayoutStore.getState().destroyLinkedPanels(id);
    await window.agentSmith.archiveSession(id);
  }, []);

  const handleUnarchiveSession = useCallback(async (id: string) => {
    const store = useSessionStore.getState();
    store.bumpAttachGen(id);
    store.updateSession(id, { archived: false, dead: false });
    store.setActiveSessionId(id);
    // PTY attach is handled by panel instance components when they detect the new currentSessionId
  }, []);

  const handleReviveSession = useCallback(async (id: string) => {
    const store = useSessionStore.getState();
    store.bumpAttachGen(id);
    store.updateSession(id, { dead: false, state: 'idle' });
    store.setActiveSessionId(id);
    await window.agentSmith.reviveSession(id);
  }, []);

  const handleRenameSession = useCallback(async (id: string, name: string) => {
    await window.agentSmith.renameSession(id, name);
    useSessionStore.getState().updateSession(id, { name });
  }, []);

  const handleAddProject = useCallback((key: string, repo: string, group: string) => {
    return useProjectStore.getState().addProject(key, repo, group);
  }, []);

  const handleRemoveProject = useCallback((key: string) => {
    return useProjectStore.getState().removeProject(key);
  }, []);

  const handleAddGroup = useCallback((name: string) => {
    return useProjectStore.getState().addGroup(name);
  }, []);

  const handleRemoveGroup = useCallback((name: string) => {
    return useProjectStore.getState().removeGroup(name);
  }, []);

  const handleMoveWorkspace = useCallback((key: string, toGroup: string, toIndex: number) => {
    return useProjectStore.getState().moveWorkspace(key, toGroup, toIndex);
  }, []);

  const handleReorderGroup = useCallback((name: string, toIndex: number) => {
    return useProjectStore.getState().reorderGroup(name, toIndex);
  }, []);

  const handleJiraPlan = useCallback((sessionId: string, key: string) => {
    window.agentSmith.ptyWrite(sessionId, `Plan ${key}\r`);
  }, []);

  // --- Spawn panels from context menu / double-click ---

  const handleSpawnPanel = useCallback((type: PanelType, sessionId: string): string | null => {
    const store = useLayoutStore.getState();
    return store.spawnPanel(type, sessionId);
  }, []);

  const focusPanelById = useCallback((panelId: string) => {
    useLayoutStore.getState().bringToFront(panelId);
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-panel-id="${panelId}"]`) as HTMLElement | null;
      el?.focus();
    });
  }, []);

  const handleDoubleClickSession = useCallback((sessionId: string) => {
    const types: PanelType[] = ['terminal', 'shell', 'jira'];
    for (const type of types) {
      handleSpawnPanel(type, sessionId);
    }
    // Activate the session (switches default panels) — focus stays on Sessions panel
    useSessionStore.getState().setActiveSessionId(sessionId);
  }, [handleSpawnPanel]);

  const handleContextMenuSpawn = useCallback((type: PanelType, sessionId: string) => {
    const store = useLayoutStore.getState();
    const spawned = handleSpawnPanel(type, sessionId);
    if (spawned) {
      // New panel created — focus it
      focusPanelById(spawned);
    } else {
      // Panel already existed — focus the existing one
      const existing = store.findLinkedPanel(type, sessionId);
      if (existing) {
        focusPanelById(existing.id);
      }
    }
    // Activate the session after spawning (per A4)
    useSessionStore.getState().setActiveSessionId(sessionId);
  }, [handleSpawnPanel, focusPanelById]);

  // --- Render body / title / focusEntry for each panel instance ---

  const renderBody = useCallback((instance: PanelInstance): React.ReactNode => {
    switch (instance.type) {
      case 'sessions':
        return (
          <SessionList
            ref={sessionListRef}
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
            onDoubleClickSession={handleDoubleClickSession}
            onContextMenuSpawn={handleContextMenuSpawn}
            onRename={handleRenameSession}
            openDropdownWithKeyboardRef={openDropdownWithKeyboardRef}
          />
        );
      case 'terminal':
        return (
          <TerminalPanelInstance
            instance={instance}
            openDropdownWithKeyboardRef={openDropdownWithKeyboardRef}
          />
        );
      case 'shell':
        return (
          <ShellPanelInstance
            instance={instance}
            openDropdownWithKeyboardRef={openDropdownWithKeyboardRef}
          />
        );
      case 'jira':
        return (
          <JiraPanelInstance
            instance={instance}
            onPlan={handleJiraPlan}
            jiraRefs={jiraRefs}
          />
        );
      default:
        return null;
    }
  }, [
    sessions, activeSessionId, projectGroups, setActiveSessionId,
    handleCreateSession, handleArchiveSession, handleUnarchiveSession,
    handleDestroySession, handleReviveSession, handleRenameSession,
    handleAddProject, handleRemoveProject, handleAddGroup, handleRemoveGroup,
    handleMoveWorkspace, handleReorderGroup, handleDoubleClickSession,
    handleContextMenuSpawn, handleJiraPlan,
  ]);

  const renderTitle = useCallback((instance: PanelInstance): React.ReactNode => {
    if (instance.type === 'sessions') return PANEL_LABELS[instance.type];

    const sid = instance.currentSessionId;
    const session = sid ? sessions.find((s) => s.id === sid) : null;
    return (
      <>
        <span className="workspace-panel__title-main">{PANEL_LABELS[instance.type]}</span>
        {session && (
          <span className="workspace-panel__title-sub">{session.name}</span>
        )}
      </>
    );
  }, [sessions]);

  const focusEntry = useCallback((instance: PanelInstance): (() => void) | undefined => {
    if (instance.type === 'sessions') {
      return () => sessionListRef.current?.focus();
    }
    // Terminal, shell, jira — xterm/jira pane handles focus internally
    return undefined;
  }, []);

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
          <PanelMenu />
          <ZoomControl />
          <ThemeSelector />
        </div>
      </header>
      <div className="app-body">
        <Workspace renderBody={renderBody} renderTitle={renderTitle} focusEntry={focusEntry} />
      </div>
    </div>
  );
}
