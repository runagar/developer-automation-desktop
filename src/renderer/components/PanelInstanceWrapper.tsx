import React from 'react';
import { PanelInstance } from '../dashboard/layout';
import { useSessionStore } from '../stores/sessionStore';
import { Session } from '../../main/types';

interface PanelInstanceWrapperProps {
  instance: PanelInstance;
  /**
   * Optional custom header content (replaces default header entirely if provided).
   * Called with `null` for session-less panels when `allowNoSession` is set.
   */
  renderHeader?: (session: Session | null) => React.ReactNode;
  /** Content to render after the standard header items (e.g. resume button) */
  headerExtra?: (session: Session) => React.ReactNode;
  /** The pane body rendered when a session is active */
  children: (session: Session) => React.ReactNode;
  /** Custom empty state text (defaults to "NO ACTIVE SESSION") */
  emptyText?: string;
  /** Whether to use smaller empty state styling */
  smallEmpty?: boolean;
  /** Whether to skip requiring a session (for global panels like Notes) */
  allowNoSession?: boolean;
  /** React key for the workspace-slot div (forces remount on change, e.g. session switch) */
  slotKey?: string;
}

/**
 * Generic wrapper for panel instance components.
 * Handles session lookup from store (with granular selector to avoid unnecessary re-renders),
 * renders the standard "no session" empty state, and provides the common header layout.
 */
function PanelInstanceWrapperInner({
  instance,
  renderHeader,
  headerExtra,
  children,
  emptyText = 'NO ACTIVE SESSION',
  smallEmpty = false,
  allowNoSession = false,
  slotKey,
}: PanelInstanceWrapperProps): React.ReactElement {
  // Granular selector: only re-renders when this specific session changes
  const session = useSessionStore((s) =>
    s.sessions.find((sess) => sess.id === instance.currentSessionId) ?? null
  );

  if (!allowNoSession && !session) {
    return (
      <div className="workspace-fill">
        <div className={`app-empty${smallEmpty ? ' app-empty--small' : ''}`}>
          {smallEmpty ? (
            <div className="app-empty__sub">{emptyText}</div>
          ) : (
            <>
              <div className="app-empty__text">{emptyText}</div>
              <div className="app-empty__sub">CREATE A NEW SESSION TO BEGIN</div>
            </>
          )}
        </div>
      </div>
    );
  }

  // For allowNoSession panels (global notes, REST panels), session may be null
  if (!session && allowNoSession) {
    return (
      <div className="workspace-fill">
        <div className="workspace-slot">
          {renderHeader?.(null)}
          {children(null as any)}
        </div>
      </div>
    );
  }

  return (
    <div className="workspace-fill">
      <div key={slotKey} className="workspace-slot">
        {renderHeader ? (
          renderHeader(session!)
        ) : (
          <div className="terminal-pane__header">
            <span className="terminal-pane__name">{session!.name}</span>
            {session!.project && (
              <span className="terminal-pane__project">[ {session!.project} ]</span>
            )}
            <span className="terminal-pane__dir">{session!.workingDir}</span>
            {headerExtra?.(session!)}
          </div>
        )}
        {children(session!)}
      </div>
    </div>
  );
}

export const PanelInstanceWrapper = React.memo(PanelInstanceWrapperInner);
