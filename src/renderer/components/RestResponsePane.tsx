import React, { useCallback, useMemo, useRef, useState } from 'react';
import { ChevronsDownUp, ChevronsUpDown, ChevronDown, ChevronRight, Copy, X } from 'lucide-react';
import { cn } from '../utils/cn';
import { usePanelFocus } from '../dashboard/usePanelFocus';
import { ResponseTab, useRestStore } from '../stores/restStore';
import { allExpandableIds, buildRows, classifyBody, topLevelExpandableIds } from '../stores/responseTree';
import ResponseTree from './ResponseTree';
import './RestResponsePane.css';

/**
 * Expanding more rows than this in one click would build tens of thousands of
 * DOM nodes and hang the renderer.
 */
const MAX_EXPAND_ALL_ROWS = 10_000;

/** Shared so a tab with nothing expanded keeps one identity across renders. */
const NO_EXPANSION: Set<string> = new Set();

function statusLabel(tab: ResponseTab): string {
  if (tab.loading) return '…';
  if (!tab.result) return '';
  if (!tab.result.ok) return 'FAILED';
  return `${tab.result.status} ${tab.result.statusText}`.trim();
}

/** REST Response body — one tab per executed call. */
export default function RestResponsePane(): React.ReactElement {
  const rootRef = useRef<HTMLDivElement>(null);
  usePanelFocus(rootRef);

  const responses = useRestStore((s) => s.responses);
  const activeResponseId = useRestStore((s) => s.activeResponseId);
  const setActiveResponse = useRestStore((s) => s.setActiveResponse);
  const closeResponseTab = useRestStore((s) => s.closeResponseTab);
  const followLink = useRestStore((s) => s.followLink);
  const copyLinkToCrafter = useRestStore((s) => s.copyLinkToCrafter);

  // Expansion lives here rather than in ResponseTree: the expand-all control
  // sits in this header, and a parent cannot set a child's state.
  const [expandedByTab, setExpandedByTab] = useState<Record<string, Set<string>>>({});
  const [headersOpen, setHeadersOpen] = useState(false);
  const [expandNotice, setExpandNotice] = useState<string | null>(null);

  const active = responses.find((r) => r.id === activeResponseId) ?? null;

  const view = useMemo(() => {
    if (!active?.result || !active.result.ok) return null;
    return classifyBody(active.result.body, active.result.headers, active.result.truncated);
  }, [active]);

  // A response opens with its top level expanded — the shape of the payload is
  // what anyone reads first — and everything below it collapsed. The default is
  // dropped entirely if it would already blow the render budget, so a wide
  // response cannot hang the renderer before the user has asked for anything.
  const defaultExpanded = useMemo(() => {
    if (view?.kind !== 'tree') return NO_EXPANSION;
    const ids = topLevelExpandableIds(view.data);
    if (ids.length === 0) return NO_EXPANSION;
    const candidate = new Set(ids);
    return buildRows(view.data, candidate).length > MAX_EXPAND_ALL_ROWS
      ? NO_EXPANSION
      : candidate;
  }, [view]);

  const expanded = (activeResponseId && expandedByTab[activeResponseId]) || defaultExpanded;

  const rows = useMemo(
    () => (view?.kind === 'tree' ? buildRows(view.data, expanded) : []),
    [view, expanded]
  );

  const toggle = useCallback((id: string) => {
    if (!activeResponseId) return;
    setExpandedByTab((prev) => {
      // Falls back to the opening expansion rather than an empty set: without
      // that, the first click on a top-level row would re-add an id that is
      // already expanded by default and the row would refuse to close.
      const current = prev[activeResponseId] ?? defaultExpanded;
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ...prev, [activeResponseId]: next };
    });
  }, [activeResponseId, defaultExpanded]);

  const expandAll = useCallback(() => {
    if (!activeResponseId || view?.kind !== 'tree') return;
    setExpandNotice(null);
    const all = allExpandableIds(view.data);
    const fullSize = buildRows(view.data, new Set(all)).length;
    if (fullSize > MAX_EXPAND_ALL_ROWS) {
      setExpandNotice(
        `Expanding everything would show ${fullSize.toLocaleString()} rows — too many to render. `
        + 'Expand sections individually instead.'
      );
      return;
    }
    setExpandedByTab((prev) => ({ ...prev, [activeResponseId]: new Set(all) }));
  }, [activeResponseId, view]);

  const collapseAll = useCallback(() => {
    if (!activeResponseId) return;
    setExpandNotice(null);
    // An explicit empty set, not a delete: the tab must stay collapsed rather
    // than fall back to the opening expansion.
    setExpandedByTab((prev) => ({ ...prev, [activeResponseId]: new Set() }));
  }, [activeResponseId]);

  const handleClose = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    closeResponseTab(id);
    // Drop the closed tab's expansion state, or an unbounded history leaves an
    // unbounded map of orphaned sets behind it.
    setExpandedByTab((prev) => {
      if (!(id in prev)) return prev;
      const { [id]: _gone, ...rest } = prev;
      return rest;
    });
  }, [closeResponseTab]);

  const copyBody = useCallback(() => {
    if (active?.result) window.dad.clipboardWrite(active.result.body);
  }, [active]);

  if (responses.length === 0) {
    return (
      <div className="app-empty" ref={rootRef}>
        <div className="app-empty__text">REST RESPONSE</div>
        <div className="app-empty__sub">NO REQUEST SENT YET</div>
      </div>
    );
  }

  const result = active?.result ?? null;
  const failed = result !== null && !result.ok;

  return (
    <div className="rest-response-pane" ref={rootRef}>
      <div className="tab-bar">
        {responses.map((tab) => (
          <div
            key={tab.id}
            className={cn('tab', tab.id === activeResponseId && 'tab--active')}
            onClick={() => setActiveResponse(tab.id)}
            title={tab.url}
          >
            <span className="tab__name">{tab.title}</span>
            <button
              className="tab__close"
              onClick={(e) => handleClose(e, tab.id)}
              title="Close response"
            >
              <X size={10} />
            </button>
          </div>
        ))}
      </div>

      {active && (
        <div className="rest-response-pane__bar">
          <span
            className={cn(
              'rest-response-pane__status',
              failed || (result && result.status >= 400)
                ? 'rest-response-pane__status--bad'
                : 'rest-response-pane__status--good',
            )}
          >
            {statusLabel(active)}
          </span>
          <span className="rest-response-pane__method">{active.method}</span>
          <span className="rest-response-pane__url" title={active.url}>{active.url}</span>
          {result && <span className="rest-response-pane__time">{result.durationMs} ms</span>}
          {view?.kind === 'tree' && (
            <>
              <button
                className="btn btn--micro rest-response-pane__action"
                onClick={expandAll}
                title="Expand all"
              >
                <ChevronsUpDown size={12} />
              </button>
              <button
                className="btn btn--micro rest-response-pane__action"
                onClick={collapseAll}
                title="Collapse all"
              >
                <ChevronsDownUp size={12} />
              </button>
            </>
          )}
          {result && (
            <button
              className="btn btn--micro rest-response-pane__action"
              onClick={copyBody}
              title="Copy the response body"
            >
              <Copy size={12} />
            </button>
          )}
        </div>
      )}

      {/*
        * Offered whatever the status was: a link is tried at v=1, and the
        * service may want a different accept-version. Handing the request to
        * the Crafter lets the user set it themselves.
        */}
      {active && active.origin === 'link' && !active.loading && (
        <div className="rest-response-pane__handoff">
          <button
            className="btn btn--micro"
            onClick={() => copyLinkToCrafter(active.id)}
            title="Load this link into the REST Crafter, where you can set the accept-version"
          >
            COPY TO CRAFTER
          </button>
        </div>
      )}

      {active?.loading && (
        <div className="rest-response-pane__notice">Waiting for a response…</div>
      )}

      {failed && <div className="rest-response-pane__error">{result?.error}</div>}

      {result && result.headers.length > 0 && (
        <div className="rest-response-pane__headers">
          <button
            className="rest-response-pane__headers-toggle"
            onClick={() => setHeadersOpen((v) => !v)}
          >
            {headersOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            <span>RESPONSE HEADERS</span>
            <span className="rest-response-pane__count">{result.headers.length}</span>
          </button>
          {headersOpen && (
            <div className="rest-response-pane__headers-body">
              {result.headers.map(([name, value], i) => (
                <div className="rest-response-pane__header-row" key={`${name}-${i}`}>
                  <span className="rest-response-pane__key">{name}:</span>
                  <span className="rest-response-pane__value">{value}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {result?.truncated && (
        <div className="rest-response-pane__notice">
          Response truncated — only the first 5 MB was received.
        </div>
      )}

      {expandNotice && <div className="rest-response-pane__notice">{expandNotice}</div>}

      {view?.kind === 'raw' && view.notice && (
        <div className="rest-response-pane__notice">{view.notice}</div>
      )}

      <div className="rest-response-pane__body">
        {view?.kind === 'tree' && (
          <ResponseTree
            rows={rows}
            expanded={expanded}
            onToggle={toggle}
            onFollowLink={(url) => { void followLink(url); }}
          />
        )}
        {view?.kind === 'raw' && <pre className="rest-response-pane__raw">{result?.body}</pre>}
        {view?.kind === 'binary' && (
          <div className="rest-response-pane__placeholder">
            {view.contentType} — {view.bytes.toLocaleString()} bytes, not displayed.
          </div>
        )}
        {view?.kind === 'empty' && (
          <div className="rest-response-pane__placeholder">No content.</div>
        )}
      </div>
    </div>
  );
}
