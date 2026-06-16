import React, { useCallback, useEffect, useRef } from 'react';
import { PanelId } from './dashboard/layout';
import SessionList, { SessionListHandle } from './components/SessionList';
import ShellPanelBody from './components/ShellPanelBody';
import TerminalPanelBody from './components/TerminalPanelBody';
import JiraPanelBody from './components/JiraPanelBody';
import { JiraPaneHandle } from './components/JiraPane';
import { ShellPaneHandle } from './components/ShellPane';
import { TerminalPaneHandle } from './components/TerminalPane';
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
  const terminalRefs = useRef<Map<string, TerminalPaneHandle>>(new Map());
  const shellRefs = useRef<Map<string, ShellPaneHandle>>(new Map());
  const jiraRefs = useRef<Map<string, JiraPaneHandle>>(new Map());
  const ptyWriters = useRef<Map<string, (data: string) => void>>(new Map());
  const shellWriters = useRef<Map<string, (data: string) => void>>(new Map());

  const waitForRemount = () => new Promise<void>((resolve) => setTimeout(resolve, 60));

  const focusTerminal = useCallback((id: string) => {
    const layoutStore = useLayoutStore.getState();
    if (!layoutStore.layout.terminal.visible) return;
    layoutStore.bringToFront('terminal');
    terminalRefs.current.get(id)?.focus();
  }, []);

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
      initJiraStore(useSessionStore.getState().sessions);
      cleanup = registerSessionListeners();
      void useProjectStore.getState().loadGroups();
    })();

    return () => {
      cancelled = true;
      cleanup();
    };
  }, []);

  const handleTerminalInput = useCallback((sessionId: string, data: string) => {
    useJiraStore.getState().handleTerminalInput(sessionId, data);
  }, []);

  useEffect(() => {
    const osc52Re = /\x1b\]52;[cps0-9]*;([A-Za-z0-9+/=]+)(?:\x07|\x1b\\)/g;
    const unsub = window.agentSmith.onPtyData((sessionId, data) => {
      osc52Re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = osc52Re.exec(data)) !== null) {
        try {
          window.agentSmith.clipboardWrite(atob(match[1]));
        } catch {
          // Ignore invalid base64 clipboard payloads.
        }
      }
      ptyWriters.current.get(sessionId)?.(data);
      handleTerminalInput(sessionId, data);
    });
    return unsub;
  }, [handleTerminalInput]);

  useEffect(() => {
    const unsub = window.agentSmith.onShellData((sessionId, data) => {
      shellWriters.current.get(sessionId)?.(data);
    });
    return unsub;
  }, []);

  const handleCreateSession = useCallback(
    async (workingDir: string, project?: string) => {
      const session = await window.agentSmith.createSession({ workingDir, project });
      const store = useSessionStore.getState();
      store.addSession(session);
      store.setActiveSessionId(session.id);
      setTimeout(() => focusTerminal(session.id), 80);
    },
    [focusTerminal]
  );

  const handleDestroySession = useCallback(async (id: string) => {
    await window.agentSmith.destroySession(id);
    useSessionStore.getState().removeSession(id);
  }, []);

  const handleArchiveSession = useCallback(async (id: string) => {
    await window.agentSmith.archiveSession(id);
  }, []);

  const handleUnarchiveSession = useCallback(async (id: string) => {
    const store = useSessionStore.getState();
    store.bumpAttachGen(id);
    store.updateSession(id, { archived: false, dead: false });
    store.setActiveSessionId(id);
    await waitForRemount();
    const size = terminalRefs.current.get(id)?.fitAndMeasure() ?? null;
    await window.agentSmith.unarchiveSession(id, size?.cols, size?.rows);
  }, []);

  const handleReviveSession = useCallback(async (id: string) => {
    const store = useSessionStore.getState();
    store.bumpAttachGen(id);
    store.updateSession(id, { dead: false, state: 'idle' });
    store.setActiveSessionId(id);
    await waitForRemount();
    const size = terminalRefs.current.get(id)?.fitAndMeasure() ?? null;
    await window.agentSmith.reviveSession(id, size?.cols, size?.rows);
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

  const focusEntry: Record<PanelId, () => void> = {
    sessions: () => sessionListRef.current?.focus(),
    terminal: () => {
      const id = useSessionStore.getState().activeSessionId;
      if (id) terminalRefs.current.get(id)?.focus();
    },
    jira: () => {
      const id = useSessionStore.getState().activeSessionId;
      if (id) jiraRefs.current.get(id)?.focus();
    },
    shell: () => {
      const id = useSessionStore.getState().activeSessionId;
      if (id) shellRefs.current.get(id)?.focus();
    },
  };

  const handleActivateTerminal = useCallback(() => {
    const id = useSessionStore.getState().activeSessionId;
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
      <TerminalPanelBody
        onRename={handleRenameSession}
        onTerminalInput={handleTerminalInput}
        openDropdownWithKeyboardRef={openDropdownWithKeyboardRef}
        ptyWriters={ptyWriters}
        terminalRefs={terminalRefs}
      />
    ),
    jira: <JiraPanelBody onPlan={handleJiraPlan} jiraRefs={jiraRefs} />,
    shell: (
      <ShellPanelBody
        openDropdownWithKeyboardRef={openDropdownWithKeyboardRef}
        shellWriters={shellWriters}
        shellRefs={shellRefs}
      />
    ),
  };

  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null;

  const titles: Partial<Record<PanelId, React.ReactNode>> = {
    shell: (
      <>
        Shell
        {activeSession?.project && (
          <span className="terminal-pane__project">[ {activeSession.project} ]</span>
        )}
        {activeSession && (
          <span className="terminal-pane__dir">{activeSession.workingDir}</span>
        )}
      </>
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
          <PanelMenu />
          <ZoomControl />
          <ThemeSelector />
        </div>
      </header>
      <div className="app-body">
        <Workspace bodies={bodies} titles={titles} focusEntry={focusEntry} />
      </div>
    </div>
  );
}
