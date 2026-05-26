import React, { useState, useRef, useEffect } from 'react';
import { Session, ProjectEntry } from '../../main/types';
import StateIndicator from './StateIndicator';
import ConfirmDialog from './ConfirmDialog';
import './SessionList.css';

interface Props {
  sessions: Session[];
  activeSessionId: string | null;
  projects: ProjectEntry[];
  onSelect: (id: string) => void;
  onCreate: (workingDir: string, project?: string) => void;
  onDestroy: (id: string) => void;
  onRevive: (id: string) => void;
}

const DEFAULT_WORK_DIR = '/home/rulu/projects/Agent Smith';

export default function SessionList({
  sessions, activeSessionId, projects, onSelect, onCreate, onDestroy, onRevive,
}: Props): React.ReactElement {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [pendingDestroyId, setPendingDestroyId] = useState<string | null>(null);

  const pendingSession = sessions.find((s) => s.id === pendingDestroyId) ?? null;

  // Close dropdown when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <aside className="session-list">
      <div className="session-list__header">SESSIONS</div>

      <div className="session-list__new" ref={dropdownRef}>
        <button
          className="btn btn--primary session-list__new-btn"
          onClick={() => onCreate(DEFAULT_WORK_DIR)}
          title={`New session in ${DEFAULT_WORK_DIR}`}
        >
          + NEW SESSION
        </button>
        <button
          className="btn btn--icon session-list__arrow"
          onClick={() => setDropdownOpen((v) => !v)}
          title="Open in project…"
        >
          ▾
        </button>

        {dropdownOpen && (
          <div className="dropdown">
            <div className="dropdown__header">PFT BETA PROJECTS</div>
            {projects.length === 0 && (
              <div className="dropdown__empty">No projects found</div>
            )}
            {projects.map((p) => (
              <button
                key={p.key}
                className="dropdown__item"
                onClick={() => {
                  onCreate(p.workingDir, p.key);
                  setDropdownOpen(false);
                }}
              >
                <div className="dropdown__item-row">
                  <span className="dropdown__key">{p.key}</span>
                  <span className="dropdown__repo">{p.repo}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      <ul className="session-list__items">
        {sessions.map((session) => (
          <li
            key={session.id}
            className={[
              'session-item',
              session.id === activeSessionId ? 'session-item--active' : '',
              session.dead ? 'session-item--dead' : '',
            ].join(' ')}
            onClick={() => onSelect(session.id)}
          >
            <div className="session-item__top">
              <StateIndicator state={session.dead ? 'dead' : session.state} />
              <span className="session-item__name">{session.name}</span>
              <div className="session-item__actions">
                {session.dead && (
                  <button
                    className="btn btn--micro"
                    title="Revive session"
                    onClick={(e) => { e.stopPropagation(); onRevive(session.id); }}
                  >↺</button>
                )}
                <button
                  className="btn btn--micro btn--danger"
                  title="Destroy session"
                  onClick={(e) => { e.stopPropagation(); setPendingDestroyId(session.id); }}
                >✕</button>
              </div>
            </div>
            {session.project && (
              <div className="session-item__project">{session.project}</div>
            )}
            {session.restored && (
              <div className="session-item__restored">↺</div>
            )}
          </li>
        ))}
      </ul>

      {pendingSession && (
        <ConfirmDialog
          message={`Destroy "${pendingSession.name}"?`}
          detail="The session and its scrollback will be permanently removed."
          confirmLabel="DESTROY"
          onConfirm={() => {
            onDestroy(pendingSession.id);
            setPendingDestroyId(null);
          }}
          onCancel={() => setPendingDestroyId(null)}
        />
      )}
    </aside>
  );
}
