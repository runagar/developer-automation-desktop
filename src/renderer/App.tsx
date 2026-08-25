import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Globe } from 'lucide-react';
import { PanelInstance, PanelType, PANEL_LABELS } from './dashboard/layout';
import SessionList, { SessionListHandle } from './components/SessionList';
import TerminalPanelInstance from './components/TerminalPanelInstance';
import ShellPanelInstance from './components/ShellPanelInstance';
import JiraPanelInstance from './components/JiraPanelInstance';
import NotesPanelInstance from './components/NotesPanelInstance';
import { JiraPaneHandle } from './components/JiraPane';
import Workspace from './components/Workspace';
import PanelMenu from './components/PanelMenu';
import ToolTabBar from './components/ToolTabBar';
import SplashScreen from './components/SplashScreen';
import JiraSettingsDialog from './components/JiraSettingsDialog';
import NotesSettingsDialog from './components/NotesSettingsDialog';
import ManageWorkspacesDialog from './components/ManageWorkspacesDialog';
import WorkspaceDiscoveryDialog from './components/WorkspaceDiscoveryDialog';
import TitleBar from './components/TitleBar';
import { useZoomKeyboard } from './components/ZoomControl';
import { initCrtEffects } from './components/crtEffects';
import { useJiraStore, initJiraStore } from './stores/jiraStore';
import { useLayoutStore } from './stores/layoutStore';
import { useWorkspaceStore } from './stores/workspaceStore';
import {
  initSessionStore,
  registerSessionListeners,
  useSessionStore,
} from './stores/sessionStore';
import './styles/app.css';
import { DiscoveredWorkspace } from '../main/types';

declare global {
  interface Window {
    dad: import('../main/types').IpcApi;
  }
}

export default function App(): React.ReactElement {
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const setActiveSessionId = useSessionStore((s) => s.setActiveSessionId);
  const workspaceGroups = useWorkspaceStore((s) => s.groups);
  const [workspacesDialogOpen, setWorkspacesDialogOpen] = useState(false);
  const [jiraDialogOpen, setJiraDialogOpen] = useState(false);
  const [notesDialogOpen, setNotesDialogOpen] = useState(false);
  const [splashDone, setSplashDone] = useState(false);
  const [discoveryEntries, setDiscoveryEntries] = useState<DiscoveredWorkspace[] | null>(null);
  // True only for the first-launch instance, so we know whether the main-process
  // cache still needs clearing.
  const [discoveryIsPending, setDiscoveryIsPending] = useState(false);

  // Global zoom keyboard shortcuts (always active)
  useZoomKeyboard();

  // Apply CRT effect classes to .app-shell after it's rendered
  useEffect(() => { initCrtEffects(); }, []);

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
      void useWorkspaceStore.getState().loadGroups();
    })();

    return () => {
      cancelled = true;
      cleanup();
    };
  }, []);

  // First-launch workspace discovery — the scan ran in the main process during
  // startup; show it once the splash is out of the way.
  useEffect(() => {
    if (!splashDone) return;
    let cancelled = false;
    void (async () => {
      try {
        const entries = await window.dad.getPendingDiscovery();
        if (cancelled) return;
        if (entries.length > 0) {
          setDiscoveryEntries(entries);
          setDiscoveryIsPending(true);
        } else {
          void window.dad.clearPendingDiscovery();
        }
      } catch {
        // Discovery is best-effort — never block startup on it.
      }
    })();
    return () => { cancelled = true; };
  }, [splashDone]);

  const closeDiscovery = useCallback(() => {
    if (discoveryIsPending) {
      void window.dad.clearPendingDiscovery();
      setDiscoveryIsPending(false);
    }
    setDiscoveryEntries(null);
  }, [discoveryIsPending]);

  const handleOpenDiscovery = useCallback((entries: DiscoveredWorkspace[]) => {
    setDiscoveryEntries(entries);
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
    const unsub = window.dad.onPtyData((_panelInstanceId, data) => {
      osc52Re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = osc52Re.exec(data)) !== null) {
        try {
          window.dad.clipboardWrite(atob(match[1]));
        } catch {
          // Ignore invalid base64 clipboard payloads.
        }
      }
    });
    return unsub;
  }, []);

  const handleCreateSession = useCallback(
    async (workingDir: string, project?: string) => {
      const session = await window.dad.createSession({ workingDir, project });
      const store = useSessionStore.getState();
      store.addSession(session);
      store.setActiveSessionId(session.id);
    },
    []
  );

  const handleDestroySession = useCallback(async (id: string) => {
    useLayoutStore.getState().destroyLinkedPanels(id);
    await window.dad.destroySession(id);
    useSessionStore.getState().removeSession(id);
    useJiraStore.getState().cleanupSession(id);
  }, []);

  const handleArchiveSession = useCallback(async (id: string) => {
    useLayoutStore.getState().destroyLinkedPanels(id);
    await window.dad.archiveSession(id);
  }, []);

  const handleUnarchiveSession = useCallback(async (id: string) => {
    const store = useSessionStore.getState();

    // Await tmux (re)creation *before* un-archiving in the store. A cold
    // session has no tmux yet, so flipping `archived` first would let the
    // terminal panel mount and attach to a session that does not exist.
    await window.dad.unarchiveSession(id);

    store.bumpAttachGen(id);
    store.updateSession(id, { archived: false, dead: false, warm: false, state: 'idle' });
    store.setActiveSessionId(id);
    // PTY attach is handled by panel instance components when they detect the new currentSessionId
  }, []);

  const handleReviveSession = useCallback(async (id: string) => {
    const store = useSessionStore.getState();
    store.bumpAttachGen(id);
    store.updateSession(id, { dead: false, state: 'idle' });
    store.setActiveSessionId(id);
    await window.dad.reviveSession(id);
  }, []);

  const handleRenameSession = useCallback(async (id: string, name: string) => {
    await window.dad.renameSession(id, name);
    useSessionStore.getState().updateSession(id, { name });
  }, []);

  const handleRemoveWorkspace = useCallback((key: string) => {
    return useWorkspaceStore.getState().removeWorkspace(key);
  }, []);

  const handleAddGroup = useCallback((name: string) => {
    return useWorkspaceStore.getState().addGroup(name);
  }, []);

  const handleRemoveGroup = useCallback((name: string) => {
    return useWorkspaceStore.getState().removeGroup(name);
  }, []);

  const handleMoveWorkspace = useCallback((key: string, toGroup: string, toIndex: number) => {
    return useWorkspaceStore.getState().moveWorkspace(key, toGroup, toIndex);
  }, []);

  const handleReorderGroup = useCallback((name: string, toIndex: number) => {
    return useWorkspaceStore.getState().reorderGroup(name, toIndex);
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
    const types: PanelType[] = ['terminal', 'shell', 'jira', 'notes'];
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

  const renderBody = useCallback((instance: PanelInstance, isFocused: boolean): React.ReactNode => {
    switch (instance.type) {
      case 'sessions':
        return (
          <SessionList
            ref={sessionListRef}
            sessions={sessions}
            activeSessionId={activeSessionId}
            workspaceGroups={workspaceGroups}
            onSelect={setActiveSessionId}
            onCreate={handleCreateSession}
            onArchive={handleArchiveSession}
            onUnarchive={handleUnarchiveSession}
            onDestroy={handleDestroySession}
            onRevive={handleReviveSession}
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
            jiraRefs={jiraRefs}
          />
        );
      case 'notes':
        return <NotesPanelInstance instance={instance} isFocused={isFocused} />;
      default:
        return null;
    }
  }, [
    sessions, activeSessionId, workspaceGroups, setActiveSessionId,
    handleCreateSession, handleArchiveSession, handleUnarchiveSession,
    handleDestroySession, handleReviveSession, handleRenameSession,
    handleDoubleClickSession,
    handleContextMenuSpawn,
  ]);

  const renderTitle = useCallback((instance: PanelInstance): React.ReactNode => {
    if (instance.type === 'sessions') return PANEL_LABELS[instance.type];

    // Global notes panels show globe icon instead of session name
    if (instance.isGlobal) {
      return (
        <>
          <Globe size={12} style={{ marginRight: 4, opacity: 0.7 }} />
          <span className="workspace-panel__title-main">{PANEL_LABELS[instance.type]}</span>
        </>
      );
    }

    return (
      <>
        <span className="workspace-panel__title-main">{PANEL_LABELS[instance.type]}</span>
      </>
    );
  }, []);

  const focusEntry = useCallback((instance: PanelInstance): (() => void) | undefined => {
    if (instance.type === 'sessions') {
      return () => sessionListRef.current?.focus();
    }
    // Terminal, shell, jira — xterm/jira pane handles focus internally
    return undefined;
  }, []);

  return (
    <div className="app-shell">
      {!splashDone && <SplashScreen onComplete={() => setSplashDone(true)} />}
      <div className="crt-glow" aria-hidden="true" />
      <TitleBar />
      <ToolTabBar
        onOpenWorkspaces={() => setWorkspacesDialogOpen(true)}
        onOpenJira={() => setJiraDialogOpen(true)}
        onOpenNotes={() => setNotesDialogOpen(true)}
      />
      <div className="app-panel-bar">
        <PanelMenu />
      </div>
      <div className="app-body">
        <Workspace renderBody={renderBody} renderTitle={renderTitle} focusEntry={focusEntry} />
      </div>
      {jiraDialogOpen && <JiraSettingsDialog onClose={() => setJiraDialogOpen(false)} />}
      {notesDialogOpen && <NotesSettingsDialog onClose={() => setNotesDialogOpen(false)} />}
      {workspacesDialogOpen && (
        <ManageWorkspacesDialog
          workspaceGroups={workspaceGroups}
          sessions={sessions}
          onRemove={handleRemoveWorkspace}
          onAddGroup={handleAddGroup}
          onRemoveGroup={handleRemoveGroup}
          onMove={handleMoveWorkspace}
          onReorderGroup={handleReorderGroup}
          onOpenDiscovery={handleOpenDiscovery}
          suspended={discoveryEntries !== null}
          onClose={() => setWorkspacesDialogOpen(false)}
        />
      )}
      {/* Rendered last so it stacks above every other dialogue */}
      {discoveryEntries && (
        <WorkspaceDiscoveryDialog
          entries={discoveryEntries}
          existingKeys={workspaceGroups.flatMap((g) => g.workspaces.map((w) => w.key))}
          onSaved={closeDiscovery}
          onClose={closeDiscovery}
        />
      )}
    </div>
  );
}
