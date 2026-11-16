import React, { useEffect, useRef, useCallback, useState } from 'react';
import { PanelInstance } from '../dashboard/layout';
import { useSessionStore } from '../stores/sessionStore';
import { useJiraStore } from '../stores/jiraStore';
import { PanelInstanceWrapper } from './PanelInstanceWrapper';
import TerminalPane, { TerminalPaneHandle } from './TerminalPane';
import { createOsc52Handler } from '../utils/osc52';
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
  const [attachedKey, setAttachedKey] = useState<string | null>(null);

  // Granular selector for session (same as wrapper uses)
  const session = useSessionStore((s) =>
    s.sessions.find((sess) => sess.id === instance.currentSessionId) ?? null
  );
  sessionRef.current = session;
  const startupPhase = useSessionStore((s) =>
    s.startupPhases.get(instance.currentSessionId ?? '') ?? null
  );

  const gen = session ? (attachGen.get(session.id) ?? 0) : 0;
  const attachKey = `${session?.id ?? ''}:${gen}`;
  const attaching = !!session && !session.dead && !session.archived && attachedKey !== attachKey;

  const handleTerminalInput = useCallback((sessionId: string, data: string) => {
    useJiraStore.getState().handleTerminalInput(sessionId, data);
  }, []);

  const handleResume = useCallback(() => {
    const s = sessionRef.current;
    if (s && s.agent === 'copilot' && s.state === 'suspended') {
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
      try {
        await window.dad.ptyAttach(
          session.id,
          instance.id,
          size?.cols ?? 120,
          size?.rows ?? 36
        );
      } finally {
        if (!cancelled) setAttachedKey(attachKey);
      }
      if (cancelled) return;
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
  }, [instance.id, attachKey]);

  // Listen for PTY data for this panel instance
  useEffect(() => {
    const decodeOsc52 = createOsc52Handler((text) => window.dad.clipboardWrite(text));
    const unsub = window.dad.onPtyData((panelInstanceId, sessionId, data) => {
      if (panelInstanceId !== instance.id || sessionId !== sessionRef.current?.id) return;
      termRef.current?.write(decodeOsc52(data));
      handleTerminalInput(sessionId, data);
    });
    return unsub;
  }, [instance.id, session?.id, handleTerminalInput]);

  return (
    <PanelInstanceWrapper
      instance={instance}
      slotKey={attachKey}
      headerExtra={(s) => s.agent === 'copilot' && s.state === 'suspended' ? (
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
          attaching={attaching}
          startupPhase={startupPhase}
          onResume={handleResume}
          openDropdownWithKeyboardRef={openDropdownWithKeyboardRef}
        />
      )}
    </PanelInstanceWrapper>
  );
}
