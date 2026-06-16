import React, { useEffect, useState } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import TerminalPane, { TerminalPaneHandle } from './TerminalPane';

const MAX_MOUNTED = 3;

interface Props {
  onRename: (id: string, name: string) => void;
  onTerminalInput?: (sessionId: string, data: string) => void;
  openDropdownWithKeyboardRef: React.MutableRefObject<() => void>;
  ptyWriters: React.MutableRefObject<Map<string, (data: string) => void>>;
  terminalRefs: React.MutableRefObject<Map<string, TerminalPaneHandle>>;
}

export default function TerminalPanelBody({
  onRename,
  onTerminalInput,
  openDropdownWithKeyboardRef,
  ptyWriters,
  terminalRefs,
}: Props): React.ReactElement {
  const sessions = useSessionStore((s) => s.sessions);
  const activeId = useSessionStore((s) => s.activeSessionId);
  const attachGen = useSessionStore((s) => s.attachGen);
  const [mountedIds, setMountedIds] = useState<string[]>([]);

  useEffect(() => {
    if (!activeId) return;
    setMountedIds((prev) => {
      const existing = new Set(sessions.map((s) => s.id));
      const cleaned = prev.filter((id) => existing.has(id) && id !== activeId);
      return [activeId, ...cleaned].slice(0, MAX_MOUNTED);
    });
  }, [activeId, sessions]);

  return (
    <div className="workspace-fill">
      {sessions.length === 0 && (
        <div className="app-empty">
          <div className="app-empty__text">NO ACTIVE SESSION</div>
          <div className="app-empty__sub">CREATE A NEW SESSION TO BEGIN</div>
        </div>
      )}
      {mountedIds.map((id) => {
        const session = sessions.find((s) => s.id === id);
        if (!session) return null;
        const gen = attachGen.get(id) ?? 0;
        return (
          <div
            key={`${id}:${gen}`}
            className="workspace-slot"
            style={id === activeId ? undefined : { display: 'none' }}
          >
            <TerminalPane
              ref={(handle) => {
                if (handle) {
                  terminalRefs.current.set(id, handle);
                  ptyWriters.current.set(id, handle.write);
                } else {
                  terminalRefs.current.delete(id);
                  ptyWriters.current.delete(id);
                }
              }}
              session={session}
              isActive={id === activeId}
              onRename={onRename}
              onTerminalInput={onTerminalInput}
              openDropdownWithKeyboardRef={openDropdownWithKeyboardRef}
            />
          </div>
        );
      })}
    </div>
  );
}
