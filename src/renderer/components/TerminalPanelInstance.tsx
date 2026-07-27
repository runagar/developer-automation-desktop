import React, { useEffect, useRef, useCallback } from 'react';
import { PanelInstance } from '../dashboard/layout';
import { useSessionStore } from '../stores/sessionStore';
import { useJiraStore } from '../stores/jiraStore';
import { PanelInstanceWrapper } from './PanelInstanceWrapper';
import TerminalPane, { TerminalPaneHandle } from './TerminalPane';
import { handleOsc52 } from '../utils/osc52';
import { Session } from '../../main/types';

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
  const attachGen = useSessionStore((s) => s.attachGen);
  const termRef = useRef<TerminalPaneHandle | null>(null);
  const attachedRef = useRef<string | null>(null);
  const sessionRef = useRef<Session | null>(null);

  // Granular selector for session (same as wrapper uses)
  const session = useSessionStore((s) =>
    s.sessions.find((sess) => sess.id === instance.currentSessionId) ?? null
  );
  sessionRef.current = session;

  const handleTerminalInput = useCallback((sessionId: string, data: string) => {
    useJiraStore.getState().handleTerminalInput(sessionId, data);
  }, []);

  const handleResume = useCallback(() => {
    const s = sessionRef.current;
    if (s && s.state === 'suspended') {
      void window.dad.resumeSession(s.id);
    }
  }, []);

  // Attach PTY when session changes or on mount
  useEffect(() => {
    if (!session || session.dead || session.archived) {
      if (attachedRef.current) {
        void window.dad.ptyDetach(instance.id);
        attachedRef.current = null;
      }
      return;
    }

    let cancelled = false;

    const doAttach = async () => {
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      if (cancelled) return;
      const size = termRef.current?.fitAndMeasure();
      await window.dad.ptyAttach(
        session.id,
        instance.id,
        size?.cols ?? 120,
        size?.rows ?? 36
      );
      if (cancelled) {
        // Attached but effect was cleaned up — detach the stale attachment
        void window.dad.ptyDetach(instance.id);
        return;
      }
      attachedRef.current = session.id;
      const postSize = termRef.current?.fitAndMeasure();
      if (postSize) {
        void window.dad.ptyResizePanel(instance.id, postSize.cols, postSize.rows);
      }
    };

    void doAttach();

    return () => {
      cancelled = true;
      void window.dad.ptyDetach(instance.id);
      attachedRef.current = null;
    };
  }, [instance.id, session?.id, attachGen.get(instance.currentSessionId ?? '') ?? 0]);

  // Listen for PTY data for this panel instance
  useEffect(() => {
    const unsub = window.dad.onPtyData((panelInstanceId, data) => {
      if (panelInstanceId !== instance.id) return;
      const cleaned = handleOsc52(data);
      termRef.current?.write(cleaned);
      if (session) handleTerminalInput(session.id, data);
    });
    return unsub;
  }, [instance.id, session?.id, handleTerminalInput]);

  const gen = session ? (attachGen.get(session.id) ?? 0) : 0;

  return (
    <PanelInstanceWrapper
      instance={instance}
      slotKey={`${session?.id ?? ''}:${gen}`}
      headerExtra={(s) => s.state === 'suspended' ? (
        <button
          className="btn btn--micro terminal-pane__resume-btn"
          onClick={handleResume}
          title="Resume suspended session (Alt+R)"
        >
          ▶ RESUME
        </button>
      ) : null}
    >
      {(s) => (
        <TerminalPane
          ref={(handle) => { termRef.current = handle; }}
          session={s}
          isActive={true}
          onResume={handleResume}
          openDropdownWithKeyboardRef={openDropdownWithKeyboardRef}
        />
      )}
    </PanelInstanceWrapper>
  );
}
