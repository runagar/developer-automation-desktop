import React, { useCallback, useEffect, useRef } from 'react';
import { PanelInstance } from '../dashboard/layout';
import { useSessionStore } from '../stores/sessionStore';
import { useJiraStore } from '../stores/jiraStore';
import { useLayoutStore } from '../stores/layoutStore';
import { PanelInstanceWrapper } from './PanelInstanceWrapper';
import { JiraPane, JiraPaneHandle } from './JiraPane';
import { JiraIssue } from '../../main/types';
import './TerminalPane.css';

interface Props {
  instance: PanelInstance;
  jiraRefs: React.MutableRefObject<Map<string, JiraPaneHandle>>;
}

/**
 * Renders a single JiraPane for a panel instance's currentSessionId.
 */
export default function JiraPanelInstance({
  instance,
  jiraRefs,
}: Props): React.ReactElement {
  const session = useSessionStore((s) =>
    s.sessions.find((sess) => sess.id === instance.currentSessionId) ?? null
  );
  const issue = useJiraStore((s) => s.issues.get(instance.id) ?? null);
  const autoFetchEnabled = useJiraStore((s) => s.autoFetchEnabled);
  const toggleAutoFetch = useJiraStore((s) => s.toggleAutoFetch);
  const setIssue = useJiraStore((s) => s.setIssue);
  const isDefault = instance.mode === 'default';

  // Seed this panel's issue from session.jiraData when session changes (default panels only)
  const clearIssue = useJiraStore((s) => s.clearIssue);
  const prevSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isDefault || !session) return;
    if (session.id !== prevSessionIdRef.current) {
      prevSessionIdRef.current = session.id;
      if (session.jiraData) {
        setIssue(instance.id, session.jiraData);
      } else {
        clearIssue(instance.id);
      }
    }
  }, [isDefault, session, instance.id, setIssue, clearIssue]);

  const handleIssueLoaded = useCallback((fetched: JiraIssue) => {
    setIssue(instance.id, fetched);
    if (isDefault && session) {
      void window.dad.saveJiraIssue(session.id, fetched);
      useSessionStore.getState().updateSession(session.id, { jiraData: fetched });
    }
  }, [instance.id, isDefault, session, setIssue]);

  const handleIssueLinkClick = useCallback(async (key: string, ctrlKey: boolean) => {
    if (ctrlKey && session) {
      const newPanelId = useLayoutStore.getState().spawnPanel('jira', session.id);
      if (newPanelId) {
        try {
          const fetched = await window.dad.getOrFetchJiraIssue(key);
          useJiraStore.getState().setIssue(newPanelId, fetched);
        } catch { /* panel spawned but issue failed — user can manually fetch */ }
      }
    } else {
      try {
        const fetched = await window.dad.getOrFetchJiraIssue(key);
        handleIssueLoaded(fetched);
      } catch { /* ignore — user can retry */ }
    }
  }, [session, handleIssueLoaded]);

  return (
    <PanelInstanceWrapper instance={instance} smallEmpty>
      {(s) => (
        <JiraPane
          ref={(handle) => {
            if (handle) jiraRefs.current.set(`${instance.id}:${s.id}`, handle);
            else jiraRefs.current.delete(`${instance.id}:${s.id}`);
          }}
          sessionId={s.id}
          issue={issue}
          autoFetchEnabled={autoFetchEnabled}
          onAutoFetchToggle={toggleAutoFetch}
          onIssueLoaded={handleIssueLoaded}
          onIssueLinkClick={handleIssueLinkClick}
        />
      )}
    </PanelInstanceWrapper>
  );
}
