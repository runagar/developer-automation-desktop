import React, { useEffect, useState } from 'react';
import { useLayoutStore } from '../stores/layoutStore';
import { useSessionStore } from '../stores/sessionStore';
import ShellPane, { ShellPaneHandle } from './ShellPane';

const MAX_MOUNTED = 3;

interface Props {
  openDropdownWithKeyboardRef: React.MutableRefObject<() => void>;
  shellWriters: React.MutableRefObject<Map<string, (data: string) => void>>;
  shellRefs: React.MutableRefObject<Map<string, ShellPaneHandle>>;
}

export default function ShellPanelBody({
  openDropdownWithKeyboardRef,
  shellWriters,
  shellRefs,
}: Props): React.ReactElement {
  const sessions = useSessionStore((s) => s.sessions);
  const activeId = useSessionStore((s) => s.activeSessionId);
  const panelVisible = useLayoutStore((s) => s.layout.shell.visible);
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
        return (
          <div
            key={id}
            className="workspace-slot"
            style={id === activeId ? undefined : { display: 'none' }}
          >
            <ShellPane
              ref={(handle) => {
                if (handle) {
                  shellRefs.current.set(id, handle);
                  shellWriters.current.set(id, handle.write);
                } else {
                  shellRefs.current.delete(id);
                  shellWriters.current.delete(id);
                }
              }}
              session={session}
              isActive={id === activeId}
              panelVisible={panelVisible}
              openDropdownWithKeyboardRef={openDropdownWithKeyboardRef}
            />
          </div>
        );
      })}
    </div>
  );
}
