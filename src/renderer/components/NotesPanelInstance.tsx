import React, { useEffect } from 'react';
import { Globe } from 'lucide-react';
import { PanelInstance } from '../dashboard/layout';
import { useSessionStore } from '../stores/sessionStore';
import { useNotesStore } from '../stores/notesStore';
import NotesPane from './NotesPane';
import './NotesPane.css';

interface Props {
  instance: PanelInstance;
}

export default function NotesPanelInstance({ instance }: Props): React.ReactElement {
  const sessions = useSessionStore((s) => s.sessions);
  const session = sessions.find((s) => s.id === instance.currentSessionId) ?? null;
  const isGlobal = instance.isGlobal ?? false;

  // Determine scope key
  const scopeKey = isGlobal
    ? `global:${instance.id}`
    : session ? `session:${session.id}` : '';

  if (!isGlobal && !session) {
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
      <div className="workspace-slot">
        <div className="terminal-pane__header">
          <span className="terminal-pane__name">
            {isGlobal ? 'Notes' : session?.name ?? 'Notes'}
          </span>
          {!isGlobal && session?.project && (
            <span className="terminal-pane__project">[ {session.project} ]</span>
          )}
          {!isGlobal && session && (
            <span className="terminal-pane__dir">{session.workingDir}</span>
          )}
        </div>
        {scopeKey && <NotesPane scopeKey={scopeKey} isGlobal={isGlobal} />}
      </div>
    </div>
  );
}
