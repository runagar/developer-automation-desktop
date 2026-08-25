import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { DiscoveredWorkspace, DEFAULT_DISCOVERY_GROUP } from '../../main/types';
import { normalizeKey, isValidKey, KEY_MAX_LENGTH, KEY_FORMAT_HINT } from '../../main/workspaceKeys';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { cn } from '../utils/cn';
import ConfirmDialog from './ConfirmDialog';
import './ManageWorkspacesDialog.css';
import './WorkspaceDiscoveryDialog.css';

interface Props {
  entries: DiscoveredWorkspace[];
  existingKeys: string[];
  onSaved: () => void;
  onClose: () => void;
}

export default function WorkspaceDiscoveryDialog({
  entries,
  existingKeys,
  onSaved,
  onClose,
}: Props): React.ReactElement {
  const [rows, setRows] = useState<DiscoveredWorkspace[]>(entries);
  const [groupName, setGroupName] = useState(DEFAULT_DISCOVERY_GROUP);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [pendingClose, setPendingClose] = useState(false);

  const saveDiscovered = useWorkspaceStore((s) => s.saveDiscovered);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Spawn at a height relative to the number of entries, then lock it so
  // removing rows doesn't make the dialogue jump around under the cursor.
  // The CSS max-height still clamps this if the window is later shrunk.
  const [lockedHeight, setLockedHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (lockedHeight !== null || !dialogRef.current) return;
    setLockedHeight(dialogRef.current.getBoundingClientRect().height);
  }, [lockedHeight]);

  const existing = useMemo(() => new Set(existingKeys), [existingKeys]);

  // A key is invalid when it is malformed, duplicated in the list, or already taken.
  const invalidKeys = useMemo(() => {
    const seen = new Map<string, number>();
    for (const r of rows) seen.set(r.key, (seen.get(r.key) ?? 0) + 1);
    const bad = new Set<string>();
    for (const r of rows) {
      if (!isValidKey(r.key) || existing.has(r.key) || (seen.get(r.key) ?? 0) > 1) {
        bad.add(r.workingDir);
      }
    }
    return bad;
  }, [rows, existing]);

  const canSave = rows.length > 0 && invalidKeys.size === 0 && groupName.trim().length > 0 && !isSaving;

  // Explains to the user why SAVE is unavailable (shown as a hover tooltip).
  const saveDisabledReason = (() => {
    if (isSaving) return 'Saving…';
    if (rows.length === 0) return 'There are no workspaces to save';
    if (groupName.trim().length === 0) return 'Enter a group name to save into';
    if (invalidKeys.size > 0) return `Fix the highlighted key(s) first — ${KEY_FORMAT_HINT}, and each key must be unique`;
    return null;
  })();

  const requestClose = useCallback(() => {
    if (isSaving) return;
    // Nothing to discard when the list is empty — close straight away.
    if (rows.length === 0) { onClose(); return; }
    setPendingClose(true);
  }, [isSaving, rows.length, onClose]);

  // ESC behaves exactly like the ✕ button. While the discard confirmation is
  // open, ESC belongs to that confirmation instead.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !pendingClose) {
        e.stopImmediatePropagation();
        requestClose();
      }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [pendingClose, requestClose]);

  // Focus trap. Capture-phase so panel/session Tab cycling never fires while
  // this dialogue is open.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      e.stopImmediatePropagation();
      if (pendingClose) return;

      const root = dialogRef.current;
      if (!root) return;
      const focusable = Array.from(
        root.querySelectorAll<HTMLElement>('input:not([disabled]), button:not([disabled])'),
      );
      if (focusable.length === 0) return;

      e.preventDefault();
      const idx = focusable.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey
        ? focusable[(idx - 1 + focusable.length) % focusable.length]
        : focusable[(idx + 1) % focusable.length];
      next?.focus();
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [pendingClose]);

  const handleKeyChange = (workingDir: string, value: string) => {
    setSaveError(null);
    setRows((prev) => prev.map((r) => (
      r.workingDir === workingDir ? { ...r, key: normalizeKey(value) } : r
    )));
  };

  const handleRemoveRow = (workingDir: string) => {
    setSaveError(null);
    setRows((prev) => prev.filter((r) => r.workingDir !== workingDir));
  };

  const handleSave = useCallback(async () => {
    if (!canSave) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      const result = await saveDiscovered(rows, groupName.trim());
      if (result.saved) {
        onSaved();
      } else {
        setSaveError(result.error ?? 'Failed to save workspaces');
      }
    } catch (err: any) {
      setSaveError(err?.message ?? 'Failed to save workspaces');
    } finally {
      setIsSaving(false);
    }
  }, [canSave, saveDiscovered, rows, groupName, onSaved]);

  return (
    // Backdrop clicks are intentionally inert — the ✕ button (with its
    // confirmation) is the only way out.
    <div className="dialog-overlay">
      <div
        ref={dialogRef}
        className="manage-workspaces"
        style={lockedHeight !== null ? { height: `${lockedHeight}px` } : undefined}
        role="dialog"
        aria-modal="true"
        aria-label="Workspace Discovery"
      >
        <div className="manage-workspaces__header">
          <span className="manage-workspaces__title">⬡ WORKSPACE DISCOVERY</span>
          <button
            className="btn btn--micro"
            onClick={requestClose}
            disabled={isSaving}
            title="Close without saving"
          >✕</button>
        </div>

        <div className="manage-workspaces__body">
          {rows.length === 0 ? (
            <div className="manage-workspaces__empty">No new workspaces found</div>
          ) : (
            <table className="manage-workspaces__table">
              <thead>
                <tr>
                  <th>KEY</th>
                  <th>REPO</th>
                  <th>DIR</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.workingDir} className="manage-workspaces__row">
                    <td className="manage-workspaces__col-key">
                      <input
                        className={cn(
                          'manage-workspaces__input',
                          'workspace-discovery__key-input',
                          invalidKeys.has(row.workingDir) && 'workspace-discovery__key-input--invalid',
                        )}
                        value={row.key}
                        maxLength={KEY_MAX_LENGTH}
                        disabled={isSaving}
                        onChange={(e) => handleKeyChange(row.workingDir, e.target.value)}
                        title={invalidKeys.has(row.workingDir)
                          ? `Invalid or duplicate key — ${KEY_FORMAT_HINT}, and each key must be unique`
                          : undefined}
                        aria-invalid={invalidKeys.has(row.workingDir)}
                        aria-label={`Key for ${row.repo}`}
                      />
                    </td>
                    <td className="manage-workspaces__col-repo">{row.repo}</td>
                    <td className="manage-workspaces__col-dir">{row.workingDir}</td>
                    <td className="manage-workspaces__col-actions">
                      <button
                        className="btn btn--micro"
                        disabled={isSaving}
                        title={`Remove ${row.repo}`}
                        onClick={() => handleRemoveRow(row.workingDir)}
                      >✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="manage-workspaces__footer">
          {rows.length > 0 && (
            <div className="workspace-discovery__group-row">
              <label className="manage-workspaces__settings-label" htmlFor="discovery-group">
                Group
              </label>
              <input
                id="discovery-group"
                className="manage-workspaces__input"
                value={groupName}
                disabled={isSaving}
                onChange={(e) => { setGroupName(e.target.value); setSaveError(null); }}
                placeholder="GROUP NAME"
              />
            </div>
          )}

          {saveError && <span className="manage-workspaces__error">{saveError}</span>}

          {rows.length > 0 && (
            <div className="workspace-discovery__save-row">
              {/* The title lives on the wrapper: disabled buttons don't fire
                  the mouse events a tooltip needs. */}
              <span title={saveDisabledReason ?? 'Save discovered workspaces'}>
                <button
                  className="btn btn--primary"
                  disabled={!canSave}
                  onClick={() => void handleSave()}
                >
                  {isSaving ? '…' : 'SAVE'}
                </button>
              </span>
            </div>
          )}
        </div>
      </div>

      {pendingClose && (
        <ConfirmDialog
          message="Discard discovered workspaces?"
          detail="None of the discovered workspaces will be saved. Existing workspaces are not affected."
          confirmLabel="DISCARD"
          onConfirm={onClose}
          onCancel={() => setPendingClose(false)}
        />
      )}
    </div>
  );
}
