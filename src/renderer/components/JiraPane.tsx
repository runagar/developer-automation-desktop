import React, { useState, useCallback, useEffect, useRef, useImperativeHandle, forwardRef, KeyboardEvent } from 'react';
import { JiraIssue } from '../../main/types';
import { usePanelFocus } from '../dashboard/usePanelFocus';
import './JiraPane.css';

export interface JiraPaneHandle {
  focus: () => void;
}

interface JiraPaneProps {
  sessionId: string;
  issue: JiraIssue | null;
  onIssueLoaded: (sessionId: string, issue: JiraIssue) => void;
  onPlan: (sessionId: string, key: string) => void;
}

export const JiraPane = forwardRef<JiraPaneHandle, JiraPaneProps>(function JiraPane(
  { sessionId, issue, onIssueLoaded, onPlan },
  ref
) {
  const [inputKey, setInputKey] = useState(issue?.key ?? '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const keyInputRef = useRef<HTMLInputElement>(null);

  usePanelFocus(rootRef);

  useImperativeHandle(ref, () => ({
    focus: () => keyInputRef.current?.focus(),
  }), []);

  // Keep inputKey in sync when issue is loaded/restored from DB
  useEffect(() => {
    if (issue?.key) setInputKey(issue.key);
  }, [issue?.key]);

  const handleFetch = useCallback(async () => {
    const key = inputKey.trim().toUpperCase();
    if (!key) return;

    setLoading(true);
    setError(null);

    try {
      const fetched = await window.agentSmith.fetchJiraIssue(key);
      await window.agentSmith.saveJiraIssue(sessionId, fetched);
      onIssueLoaded(sessionId, fetched);
    } catch (err: any) {
      setError(err?.message ?? 'Failed to fetch issue');
    } finally {
      setLoading(false);
    }
  }, [inputKey, sessionId, onIssueLoaded]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleFetch();
      }
    },
    [handleFetch]
  );

  const handlePlan = useCallback(() => {
    if (issue) onPlan(sessionId, issue.key);
  }, [issue, sessionId, onPlan]);

  return (
    <div className="jira-pane" ref={rootRef}>
      {/* Header row: key input + fetch + plan buttons */}
      <div className="jira-pane__header">
        <input
          ref={keyInputRef}
          className="jira-pane__key-input"
          type="text"
          placeholder="PROJ-123"
          value={inputKey}
          onChange={(e) => setInputKey(e.target.value)}
          onKeyDown={handleKeyDown}
          spellCheck={false}
        />
        <button
          className="btn btn--micro jira-pane__action-btn"
          onClick={handleFetch}
          disabled={loading || !inputKey.trim()}
        >
          {loading ? '…' : 'FETCH'}
        </button>
        <button
          className="btn btn--primary btn--micro jira-pane__action-btn"
          onClick={handlePlan}
          disabled={!issue}
          title={issue ? `Send 'Fetch ${issue.key} and implement it' to the terminal` : 'Fetch an issue first'}
        >
          PLAN
        </button>
      </div>

      {/* Scrollable content */}
      <div className="jira-pane__content">
        {error && <div className="jira-pane__error">{error}</div>}

        {!issue && !error && !loading && (
          <div className="jira-pane__empty">Enter a Jira issue key and press FETCH.</div>
        )}

        {loading && <div className="jira-pane__loading">Fetching…</div>}

        {issue && !loading && (
          <>
            {/* Summary */}
            <div className="jira-pane__section">
              <div className="jira-pane__section-label">Summary</div>
              <div className="jira-pane__summary">{issue.key} — {issue.summary}</div>
            </div>

            {/* Acceptance Criteria (before description) */}
            {issue.acceptanceCriteria && (
              <div className="jira-pane__section">
                <div className="jira-pane__section-label">Acceptance Criteria</div>
                <div className="jira-pane__section-text">{issue.acceptanceCriteria}</div>
              </div>
            )}

            {/* Description */}
            {issue.description && (
              <div className="jira-pane__section">
                <div className="jira-pane__section-label">Description</div>
                <div className="jira-pane__section-text">{issue.description}</div>
              </div>
            )}

            {/* Release Notes — always shown; "N/A" if absent */}
            <div className="jira-pane__section">
              <div className="jira-pane__section-label">Release Notes</div>
              <div className="jira-pane__section-text">
                {issue.releaseNotes || 'N/A'}
              </div>
            </div>

            {/* Developer Tasks — only shown when present */}
            {issue.developerTasks && (
              <div className="jira-pane__section">
                <div className="jira-pane__section-label">Developer Tasks</div>
                <div className="jira-pane__section-text">{issue.developerTasks}</div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
});
