import React from 'react';
import { PanelInstance } from '../dashboard/layout';
import { useSessionStore } from '../stores/sessionStore';
import { useJiraStore } from '../stores/jiraStore';
import { JiraPane, JiraPaneHandle } from './JiraPane';
import './TerminalPane.css';

interface Props {
  instance: PanelInstance;
  onPlan: (sessionId: string, key: string) => void;
  jiraRefs: React.MutableRefObject<Map<string, JiraPaneHandle>>;
}

/**
 * Renders a single JiraPane for a panel instance's currentSessionId.
 */
export default function JiraPanelInstance({
  instance,
  onPlan,
  jiraRefs,
}: Props): React.ReactElement {
  const sessions = useSessionStore((s) => s.sessions);
  const session = sessions.find((s) => s.id === instance.currentSessionId) ?? null;
  const issues = useJiraStore((s) => s.issues);
  const autoFetchEnabled = useJiraStore((s) => s.autoFetchEnabled);
  const toggleAutoFetch = useJiraStore((s) => s.toggleAutoFetch);
  const setIssue = useJiraStore((s) => s.setIssue);

  if (!session) {
    return (
      <div className="workspace-fill">
        <div className="app-empty app-empty--small">
          <div className="app-empty__sub">NO ACTIVE SESSION</div>
        </div>
      </div>
    );
  }

  return (
    <div className="workspace-fill">
      <div key={session.id} className="workspace-slot">
        <div className="terminal-pane__header">
          <span className="terminal-pane__name">{session.name}</span>
          {session.project && (
            <span className="terminal-pane__project">[ {session.project} ]</span>
          )}
          <span className="terminal-pane__dir">{session.workingDir}</span>
        </div>
        <JiraPane
          ref={(handle) => {
            if (handle) jiraRefs.current.set(`${instance.id}:${session.id}`, handle);
            else jiraRefs.current.delete(`${instance.id}:${session.id}`);
          }}
          sessionId={session.id}
          issue={issues.get(session.id) ?? null}
          autoFetchEnabled={autoFetchEnabled}
          onAutoFetchToggle={toggleAutoFetch}
          onIssueLoaded={(sessionId, issue) => setIssue(sessionId, issue)}
          onPlan={onPlan}
        />
      </div>
    </div>
  );
}
