import React, { useEffect, useRef, useCallback } from 'react';
import { PanelInstance } from '../dashboard/layout';
import { useSessionStore } from '../stores/sessionStore';
import TerminalPane, { TerminalPaneHandle } from './TerminalPane';
import { useJiraStore } from '../stores/jiraStore';

interface Props {
  instance: PanelInstance;
  openDropdownWithKeyboardRef: React.MutableRefObject<() => void>;
}

/**
 * Renders a single TerminalPane for a panel instance's currentSessionId.
 * Handles PTY attach/detach lifecycle per panel instance.
 */
export default function TerminalPanelInstance({
  instance,
  openDropdownWithKeyboardRef,
}: Props): React.ReactElement {
  const sessions = useSessionStore((s) => s.sessions);
  const session = sessions.find((s) => s.id === instance.currentSessionId) ?? null;
  const attachGen = useSessionStore((s) => s.attachGen);
  const termRef = useRef<TerminalPaneHandle | null>(null);
  const attachedRef = useRef<string | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const handleTerminalInput = useCallback((sessionId: string, data: string) => {
    useJiraStore.getState().handleTerminalInput(sessionId, data);
  }, []);

  const handleResume = useCallback(() => {
    const s = sessionRef.current;
    if (s && s.state === 'suspended') {
      void window.agentSmith.resumeSession(s.id);
    }
  }, []);

  // Attach PTY when session changes or on mount
  useEffect(() => {
    if (!session || session.dead || session.archived) {
      // Detach if we were attached
      if (attachedRef.current) {
        void window.agentSmith.ptyDetach(instance.id);
        attachedRef.current = null;
      }
      return;
    }

    const doAttach = async () => {
      // Wait a frame for xterm to mount and fit
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      const size = termRef.current?.fitAndMeasure();
      await window.agentSmith.ptyAttach(
        session.id,
        instance.id,
        size?.cols ?? 120,
        size?.rows ?? 36
      );
      attachedRef.current = session.id;
      // Re-measure and resize after attach resolves — any resize events that
      // fired during the async attach window were dropped because the
      // attachment didn't exist yet in the main process.
      const postSize = termRef.current?.fitAndMeasure();
      if (postSize) {
        void window.agentSmith.ptyResizePanel(instance.id, postSize.cols, postSize.rows);
      }
    };

    void doAttach();

    return () => {
      // Detach on unmount or session change
      void window.agentSmith.ptyDetach(instance.id);
      attachedRef.current = null;
    };
  }, [instance.id, session?.id, attachGen.get(instance.currentSessionId ?? '') ?? 0]);

  // Listen for PTY data for this panel instance
  useEffect(() => {
    const unsub = window.agentSmith.onPtyData((panelInstanceId, data) => {
      if (panelInstanceId !== instance.id) return;
      termRef.current?.write(data);
      if (session) handleTerminalInput(session.id, data);
    });
    return unsub;
  }, [instance.id, session?.id, handleTerminalInput]);

  if (!session) {
    return (
      <div className="workspace-fill">
        <div className="app-empty">
          <div className="app-empty__text">NO ACTIVE SESSION</div>
          <div className="app-empty__sub">CREATE A NEW SESSION TO BEGIN</div>
        </div>
      </div>
    );
  }

  const gen = attachGen.get(session.id) ?? 0;

  return (
    <div className="workspace-fill">
      <div key={`${session.id}:${gen}`} className="workspace-slot">
        <div className="terminal-pane__header">
          <span className="terminal-pane__name">{session.name}</span>
          {session.project && (
            <span className="terminal-pane__project">[ {session.project} ]</span>
          )}
          <span className="terminal-pane__dir">{session.workingDir}</span>
          {session.state === 'suspended' && (
            <button
              className="btn btn--micro terminal-pane__resume-btn"
              onClick={handleResume}
              title="Resume suspended session (Alt+R)"
            >
              ▶ RESUME
            </button>
          )}
        </div>
        <TerminalPane
          ref={(handle) => { termRef.current = handle; }}
          session={session}
          isActive={true}
          onResume={handleResume}
          openDropdownWithKeyboardRef={openDropdownWithKeyboardRef}
        />
      </div>
    </div>
  );
}
