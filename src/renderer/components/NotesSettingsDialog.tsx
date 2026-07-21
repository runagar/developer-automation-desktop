import React, { useEffect, useState, useCallback, useRef } from 'react';
import './NotesSettingsDialog.css';

interface Props {
  onClose: () => void;
}

export default function NotesSettingsDialog({ onClose }: Props): React.ReactElement {
  const overlayRef = useRef<HTMLDivElement>(null);

  const [notesRoot, setNotesRoot] = useState('');
  const [editedPath, setEditedPath] = useState<string | null>(null);
  const [migrating, setMigrating] = useState(false);
  const [migrateError, setMigrateError] = useState<string | null>(null);
  const [migrateSaved, setMigrateSaved] = useState(false);
  const [confirmNeeded, setConfirmNeeded] = useState(false);

  useEffect(() => {
    void (async () => {
      const root = await window.dad.getNotesRootPath();
      setNotesRoot(root);
    })();
  }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // Close on overlay click
  const handleOverlayClick = useCallback((e: React.MouseEvent) => {
    if (e.target === overlayRef.current) onClose();
  }, [onClose]);

  const handleSave = useCallback(async () => {
    if (editedPath === null || editedPath === notesRoot) return;

    // Check if target directory already contains data
    if (!confirmNeeded) {
      const nonEmpty = await window.dad.isPathNonEmpty(editedPath);
      if (nonEmpty) {
        setConfirmNeeded(true);
        return;
      }
    }

    setConfirmNeeded(false);
    setMigrating(true);
    setMigrateError(null);
    setMigrateSaved(false);
    try {
      const result = await window.dad.migrateNotesRoot(editedPath);
      if (result.success) {
        setNotesRoot(editedPath);
        setEditedPath(null);
        setMigrateSaved(true);
      } else {
        setMigrateError(result.error ?? 'Migration failed');
      }
    } catch (err: any) {
      setMigrateError(err?.message ?? 'Migration failed');
    } finally {
      setMigrating(false);
    }
  }, [editedPath, notesRoot, confirmNeeded]);

  const displayPath = editedPath ?? notesRoot;
  const isEdited = editedPath !== null && editedPath !== notesRoot;

  return (
    <div className="credentials-overlay" ref={overlayRef} onClick={handleOverlayClick}>
      <div className="credentials-dialog">
        <div className="credentials-dialog__header">
          <span className="credentials-dialog__title">NOTES SETTINGS</span>
          <button className="btn btn--micro" onClick={onClose}>✕</button>
        </div>

        <div className="credentials-dialog__body">
          <div className="credentials-dialog__group">
            <div className="credentials-dialog__group-label">Settings</div>
            <div className="credentials-dialog__row">
              <div className="credentials-dialog__field-header">
                <label className="credentials-dialog__label">Notes Root Path</label>
              </div>
              <div className="credentials-dialog__field-body">
                <input
                  className={`credentials-dialog__input${migrateError ? ' credentials-dialog__input--error' : ''}`}
                  type="text"
                  value={displayPath}
                  onChange={(e) => { setEditedPath(e.target.value); setMigrateSaved(false); setMigrateError(null); setConfirmNeeded(false); }}
                  onKeyDown={(e) => { if (e.key === 'Enter' && isEdited) void handleSave(); }}
                  spellCheck={false}
                />
                {isEdited && (
                  <button
                    className="btn btn--micro credentials-dialog__save-btn"
                    onClick={() => void handleSave()}
                    disabled={migrating}
                  >
                    {migrating ? '…' : 'SAVE'}
                  </button>
                )}
              </div>
              <div className="credentials-dialog__field-status">
                {migrateError && <span className="credentials-dialog__error">{migrateError}</span>}
                {migrateSaved && <span className="credentials-dialog__saved">✓ Migrated</span>}
                {migrating && <span className="credentials-dialog__env-note">Migrating…</span>}
                {confirmNeeded && (
                  <span className="credentials-dialog__confirm">
                    <span className="credentials-dialog__env-note">
                      The specified path already contains data. Are you sure you want to move your notes to this directory? It may be difficult to untangle the data after migration.
                    </span>
                    <button className="btn btn--micro credentials-dialog__save-btn" onClick={() => void handleSave()}>✓</button>
                    <button className="btn btn--micro credentials-dialog__clear-btn" onClick={() => setConfirmNeeded(false)}>✕</button>
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
