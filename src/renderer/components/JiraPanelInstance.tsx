import React, { useCallback, useEffect, useRef } from 'react';
import { PanelInstance } from '../dashboard/layout';
import { useSessionStore } from '../stores/sessionStore';
import { useJiraStore } from '../stores/jiraStore';
import { useLayoutStore } from '../stores/layoutStore';
import { JiraPane, JiraPaneHandle } from './JiraPane';
import { JiraIssue } from '../../main/types';
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
  const issue = useJiraStore((s) => s.issues.get(instance.id) ?? null);
  const autoFetchEnabled = useJiraStore((s) => s.autoFetchEnabled);
  const toggleAutoFetch = useJiraStore((s) => s.toggleAutoFetch);
  const setIssue = useJiraStore((s) => s.setIssue);
  const isDefault = instance.mode === 'default';

  // Seed this panel's issue from session.jiraData when session changes (default panels only)
  const prevSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isDefault || !session) return;
    if (session.id !== prevSessionIdRef.current) {
      prevSessionIdRef.current = session.id;
      if (session.jiraData) {
        setIssue(instance.id, session.jiraData);
      }
    }
  }, [isDefault, session, instance.id, setIssue]);

  const handleIssueLoaded = useCallback((fetched: JiraIssue) => {
    setIssue(instance.id, fetched);
    // Only persist to DB from default panels
    if (isDefault && session) {
      void window.agentSmith.saveJiraIssue(session.id, fetched);
    }
  }, [instance.id, isDefault, session, setIssue]);

  const handleIssueLinkClick = useCallback(async (key: string, ctrlKey: boolean) => {
    if (ctrlKey && session) {
      // Ctrl+click: spawn a new linked Jira panel
      const newPanelId = useLayoutStore.getState().spawnPanel('jira', session.id);
      if (newPanelId) {
        try {
          const fetched = await window.agentSmith.getOrFetchJiraIssue(key);
          useJiraStore.getState().setIssue(newPanelId, fetched);
        } catch { /* panel spawned but issue failed — user can manually fetch */ }
      }
    } else {
      // Normal click: fetch and display in this panel
      try {
        const fetched = await window.agentSmith.getOrFetchJiraIssue(key);
        handleIssueLoaded(fetched);
      } catch { /* ignore — user can retry */ }
    }
  }, [session, handleIssueLoaded]);

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
          issue={issue}
          autoFetchEnabled={autoFetchEnabled}
          onAutoFetchToggle={toggleAutoFetch}
          onIssueLoaded={handleIssueLoaded}
          onPlan={onPlan}
          onIssueLinkClick={handleIssueLinkClick}
        />
      </div>
    </div>
  );
}
