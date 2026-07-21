import React, { useCallback, useEffect, useRef, useState } from 'react';
import { PanelInstance } from '../dashboard/layout';
import { useSessionStore } from '../stores/sessionStore';
import { useLayoutStore } from '../stores/layoutStore';
import { PanelInstanceWrapper } from './PanelInstanceWrapper';
import NotesPane from './NotesPane';
import './NotesPane.css';

interface Props {
  instance: PanelInstance;
  isFocused?: boolean;
}

export default function NotesPanelInstance({ instance, isFocused }: Props): React.ReactElement {
  const session = useSessionStore((s) =>
    s.sessions.find((sess) => sess.id === instance.currentSessionId) ?? null
  );
  const isGlobal = instance.isGlobal ?? false;
  const panelName = instance.name || 'Untitled';

  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(panelName);
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync rename value when panel name changes externally
  useEffect(() => {
    if (!renaming) setRenameValue(panelName);
  }, [panelName, renaming]);

  // Select all text when entering rename mode
  useEffect(() => {
    if (renaming && inputRef.current) {
      inputRef.current.select();
    }
  }, [renaming]);

  const handleNameClick = useCallback(() => {
    if (isGlobal && isFocused) {
      setRenaming(true);
    }
  }, [isGlobal, isFocused]);

  const handleRenameSubmit = useCallback(() => {
    const trimmed = renameValue.trim() || 'Untitled';
    setRenaming(false);
    if (trimmed !== panelName) {
      useLayoutStore.getState().renamePanel(instance.id, trimmed);
      void window.dad.notesRenamePanel(instance.id, trimmed);
    }
  }, [renameValue, panelName, instance.id]);

  // Determine scope key
  const scopeKey = isGlobal
    ? `global:${instance.id}`
    : session ? `session:${session.id}` : '';

  // Custom header for notes (handles global/session variants and rename)
  const renderHeader = () => (
    <div className="terminal-pane__header">
      <span className="terminal-pane__name">
        {isGlobal ? (
          <>
            Notes
            <span className="notes-panel__name-sep"> - </span>
            {renaming ? (
              <input
                ref={inputRef}
                className="notes-panel__name-input"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={handleRenameSubmit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleRenameSubmit();
                  if (e.key === 'Escape') { setRenaming(false); setRenameValue(panelName); }
                }}
                autoFocus
                spellCheck={false}
              />
            ) : (
              <span
                className={`notes-panel__name-label${isFocused ? ' notes-panel__name-label--editable' : ''}`}
                onClick={handleNameClick}
              >
                {panelName}
              </span>
            )}
          </>
        ) : (
          session?.name ?? 'Notes'
        )}
      </span>
      {!isGlobal && session?.project && (
        <span className="terminal-pane__project">[ {session.project} ]</span>
      )}
      {!isGlobal && session && (
        <span className="terminal-pane__dir">{session.workingDir}</span>
      )}
    </div>
  );

  if (!isGlobal && !session) {
    return (
      <PanelInstanceWrapper instance={instance} smallEmpty>
        {() => <></>}
      </PanelInstanceWrapper>
    );
  }

  return (
    <div className="workspace-fill">
      <div className="workspace-slot">
        {renderHeader()}
        {scopeKey && <NotesPane scopeKey={scopeKey} isGlobal={isGlobal} />}
      </div>
    </div>
  );
}
