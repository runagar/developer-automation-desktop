import React, { useEffect, useState } from 'react';
import { useJiraStore } from '../stores/jiraStore';
import { useSessionStore } from '../stores/sessionStore';
import { JiraPane, JiraPaneHandle } from './JiraPane';

const MAX_MOUNTED = 3;

interface Props {
  onPlan: (sessionId: string, key: string) => void;
  jiraRefs: React.MutableRefObject<Map<string, JiraPaneHandle>>;
}

export default function JiraPanelBody({ onPlan, jiraRefs }: Props): React.ReactElement {
  const sessions = useSessionStore((s) => s.sessions);
  const activeId = useSessionStore((s) => s.activeSessionId);
  const issues = useJiraStore((s) => s.issues);
  const autoFetchEnabled = useJiraStore((s) => s.autoFetchEnabled);
  const toggleAutoFetch = useJiraStore((s) => s.toggleAutoFetch);
  const setIssue = useJiraStore((s) => s.setIssue);
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
        <div className="app-empty app-empty--small">
          <div className="app-empty__sub">NO ACTIVE SESSION</div>
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
            <JiraPane
              ref={(handle) => {
                if (handle) jiraRefs.current.set(id, handle);
                else jiraRefs.current.delete(id);
              }}
              sessionId={id}
              issue={issues.get(id) ?? null}
              autoFetchEnabled={autoFetchEnabled}
              onAutoFetchToggle={toggleAutoFetch}
              onIssueLoaded={(sessionId, issue) => setIssue(sessionId, issue)}
              onPlan={onPlan}
            />
          </div>
        );
      })}
    </div>
  );
}
