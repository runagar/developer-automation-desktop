import React, { useState, useCallback, useEffect, useRef, useImperativeHandle, forwardRef, KeyboardEvent } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { JiraIssue } from '../../main/types';
import { usePanelFocus } from '../dashboard/usePanelFocus';
import './JiraPane.css';

export interface JiraPaneHandle {
  focus: () => void;
}

interface JiraPaneProps {
  sessionId: string;
  issue: JiraIssue | null;
  autoFetchEnabled: boolean;
  onAutoFetchToggle: () => void;
  onIssueLoaded: (issue: JiraIssue) => void;
  onIssueLinkClick: (key: string, ctrlKey: boolean) => void;
}

export const JiraPane = forwardRef<JiraPaneHandle, JiraPaneProps>(function JiraPane(
  { sessionId, issue, autoFetchEnabled, onAutoFetchToggle, onIssueLoaded, onIssueLinkClick },
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

  // Keep inputKey in sync when issue is loaded/restored/cleared
  useEffect(() => {
    setInputKey(issue?.key ?? '');
  }, [issue?.key]);

  const handleFetch = useCallback(async () => {
    const key = inputKey.trim().toUpperCase();
    if (!key) return;

    setLoading(true);
    setError(null);

    try {
      const fetched = await window.dad.fetchAndPopulateVault(key);
      onIssueLoaded(fetched);
    } catch (err: any) {
      setError(err?.message ?? 'Failed to fetch issue');
    } finally {
      setLoading(false);
    }
  }, [inputKey, onIssueLoaded]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleFetch();
      }
    },
    [handleFetch]
  );

  // Custom link component for ReactMarkdown: intercepts jira:// URLs
  const onIssueLinkClickRef = useRef(onIssueLinkClick);
  onIssueLinkClickRef.current = onIssueLinkClick;

  const markdownComponents = useRef({
    a: ({ href, children, ...props }: any) => {
      if (href && href.startsWith('jira://')) {
        const key = href.replace('jira://', '');
        return (
          <span
            className="jira-pane__issue-link"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onIssueLinkClickRef.current(key, e.ctrlKey || e.metaKey);
            }}
            onMouseDown={(e) => e.preventDefault()}
            role="link"
            tabIndex={0}
          >
            {children}
          </span>
        );
      }
      return <a href={href} {...props} target="_blank" rel="noopener noreferrer">{children}</a>;
    },
  }).current;

  return (
    <div className="jira-pane" ref={rootRef}>
      {/* Header row: key input + fetch + plan + auto-detect toggle */}
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
          className={`btn btn--micro jira-pane__auto-toggle${autoFetchEnabled ? ' jira-pane__auto-toggle--on' : ''}`}
          onClick={onAutoFetchToggle}
          title={autoFetchEnabled ? 'Auto-detect Jira keys: ON' : 'Auto-detect Jira keys: OFF'}
        >
          {autoFetchEnabled ? '⚡' : '⚡̸'}
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

            {/* Metadata row */}
            {(issue.status || issue.priority || issue.issueType) && (
              <div className="jira-pane__section">
                <div className="jira-pane__meta-row">
                  {[issue.status, issue.priority, issue.issueType].filter(Boolean).join(' · ')}
                </div>
              </div>
            )}

            {/* Labels */}
            {issue.labels && issue.labels.length > 0 && (
              <div className="jira-pane__section">
                <div className="jira-pane__section-label">Labels</div>
                <div className="jira-pane__chips">
                  {issue.labels.map((l) => <span key={l} className="jira-pane__chip">{l}</span>)}
                </div>
              </div>
            )}

            {/* Fix Versions */}
            {issue.fixVersions && issue.fixVersions.length > 0 && (
              <div className="jira-pane__section">
                <div className="jira-pane__section-label">Fix Versions</div>
                <div className="jira-pane__chips">
                  {issue.fixVersions.map((v) => <span key={v} className="jira-pane__chip">{v}</span>)}
                </div>
              </div>
            )}

            {/* Description (rendered Markdown) */}
            {issue.description && (
              <div className="jira-pane__section">
                <div className="jira-pane__section-label">Description</div>
                <div className="jira-pane__markdown">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={markdownComponents}
                    urlTransform={(url) => url.startsWith('jira://') ? url : defaultUrlTransform(url)}
                  >
                    {issue.description}
                  </ReactMarkdown>
                </div>
              </div>
            )}

            {/* Linked Issues */}
            {issue.linkedIssues && issue.linkedIssues.length > 0 && (
              <div className="jira-pane__section">
                <div className="jira-pane__section-label">Linked Issues</div>
                <div className="jira-pane__links">
                  {issue.linkedIssues.map((li) => (
                    <div key={li.key} className="jira-pane__link">
                      {li.relation}{' '}
                      <span
                        className="jira-pane__issue-link"
                        onClick={(e) => {
                          e.preventDefault();
                          onIssueLinkClick(li.key, e.ctrlKey || e.metaKey);
                        }}
                        onMouseDown={(e) => e.preventDefault()}
                        role="link"
                        tabIndex={0}
                      >
                        {li.key}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
});
