import React, { useEffect, useState, useCallback, useRef } from 'react';
import { CredentialStatusInfo } from '../../main/types';
import CredentialRow, { FieldState } from './CredentialRow';
import './JiraSettingsDialog.css';

interface Props {
  onClose: () => void;
}

export default function JiraSettingsDialog({ onClose }: Props): React.ReactElement {
  const overlayRef = useRef<HTMLDivElement>(null);

  // --- Vault path state ---
  const [vaultPath, setVaultPath] = useState('');
  const [editedVaultPath, setEditedVaultPath] = useState<string | null>(null);
  const [migrating, setMigrating] = useState(false);
  const [migrateError, setMigrateError] = useState<string | null>(null);
  const [migrateSaved, setMigrateSaved] = useState(false);
  const [confirmNeeded, setConfirmNeeded] = useState(false);

  // --- Credential state ---
  const [fields, setFields] = useState<FieldState[]>([]);
  const [loadingCreds, setLoadingCreds] = useState(true);

  useEffect(() => {
    void (async () => {
      const path = await window.agentSmith.getJiraVaultPath();
      setVaultPath(path);
    })();
    void loadCredentials();
  }, []);

  const loadCredentials = useCallback(async () => {
    setLoadingCreds(true);
    try {
      const statuses = await window.agentSmith.getCredentialStatus();
      // Filter to Atlassian group only
      const atlassian = statuses.filter((s) => s.group === 'Atlassian');
      setFields(atlassian.map((s) => ({
        status: s,
        editedValue: null,
        showValue: false,
        saving: false,
        error: null,
        saved: false,
      })));
    } catch { /* non-fatal */ }
    finally { setLoadingCreds(false); }
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

  // --- Vault path handlers ---
  const handleSaveVaultPath = useCallback(async () => {
    if (editedVaultPath === null || editedVaultPath === vaultPath) return;

    // Check if target directory already contains data
    if (!confirmNeeded) {
      const nonEmpty = await window.agentSmith.isPathNonEmpty(editedVaultPath);
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
      const result = await window.agentSmith.migrateJiraVault(editedVaultPath);
      if (result.success) {
        setVaultPath(editedVaultPath);
        setEditedVaultPath(null);
        setMigrateSaved(true);
      } else {
        setMigrateError(result.error ?? 'Migration failed');
      }
    } catch (err: any) {
      setMigrateError(err?.message ?? 'Migration failed');
    } finally {
      setMigrating(false);
    }
  }, [editedVaultPath, vaultPath, confirmNeeded]);

  // --- Credential handlers ---
  const updateField = (key: string, patch: Partial<FieldState>) => {
    setFields((prev) => prev.map((f) =>
      f.status.key === key ? { ...f, ...patch } : f
    ));
  };

  const handleSaveCred = useCallback(async (key: string) => {
    const field = fields.find((f) => f.status.key === key);
    if (!field || field.editedValue === null || field.status.source === 'env') return;

    updateField(key, { saving: true, error: null, saved: false });

    try {
      const results = await window.agentSmith.saveCredentials([{ key, value: field.editedValue }]);
      const result = results.find((r) => r.key === key);
      if (result?.valid) {
        updateField(key, {
          saving: false,
          saved: true,
          error: null,
          editedValue: null,
          status: { ...field.status, source: 'file', value: field.editedValue },
        });
      } else {
        updateField(key, { saving: false, error: result?.error ?? 'Validation failed' });
      }
    } catch (err: any) {
      updateField(key, { saving: false, error: err?.message ?? 'Save failed' });
    }
  }, [fields]);

  const handleClearCred = useCallback(async (key: string) => {
    const field = fields.find((f) => f.status.key === key);
    if (!field || field.status.source === 'env') return;

    try {
      await window.agentSmith.clearCredential(key);
      updateField(key, {
        editedValue: null,
        error: null,
        saved: false,
        status: { ...field.status, source: 'none', value: '' },
      });
    } catch { /* non-fatal */ }
  }, [fields]);

  const displayVaultPath = editedVaultPath ?? vaultPath;
  const isVaultEdited = editedVaultPath !== null && editedVaultPath !== vaultPath;

  return (
    <div className="credentials-overlay" ref={overlayRef} onClick={handleOverlayClick}>
      <div className="credentials-dialog">
        <div className="credentials-dialog__header">
          <span className="credentials-dialog__title">JIRA SETTINGS</span>
          <button className="btn btn--micro" onClick={onClose}>✕</button>
        </div>

        <div className="credentials-dialog__body">
          {/* Settings section */}
          <div className="credentials-dialog__group">
            <div className="credentials-dialog__group-label">Settings</div>
            <div className="credentials-dialog__row">
              <div className="credentials-dialog__field-header">
                <label className="credentials-dialog__label">Vault Path</label>
              </div>
              <div className="credentials-dialog__field-body">
                <input
                  className={`credentials-dialog__input${migrateError ? ' credentials-dialog__input--error' : ''}`}
                  type="text"
                  value={displayVaultPath}
                  onChange={(e) => { setEditedVaultPath(e.target.value); setMigrateSaved(false); setMigrateError(null); setConfirmNeeded(false); }}
                  onKeyDown={(e) => { if (e.key === 'Enter' && isVaultEdited) void handleSaveVaultPath(); }}
                  spellCheck={false}
                />
                {isVaultEdited && (
                  <button
                    className="btn btn--micro credentials-dialog__save-btn"
                    onClick={() => void handleSaveVaultPath()}
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
                      The specified path already contains data. Are you sure you want to move your Jira issues to this directory? It may be difficult to untangle the data after migration.
                    </span>
                    <button className="btn btn--micro credentials-dialog__save-btn" onClick={() => void handleSaveVaultPath()}>✓</button>
                    <button className="btn btn--micro credentials-dialog__clear-btn" onClick={() => setConfirmNeeded(false)}>✕</button>
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Credentials section */}
          <div className="credentials-dialog__group">
            <div className="credentials-dialog__group-label">Credentials</div>
            {loadingCreds && <div className="credentials-dialog__loading">Loading…</div>}
            {!loadingCreds && fields.map((f) => (
              <CredentialRow
                key={f.status.key}
                field={f}
                onEdit={(val) => updateField(f.status.key, { editedValue: val, saved: false, error: null })}
                onToggleShow={() => updateField(f.status.key, { showValue: !f.showValue })}
                onSave={() => handleSaveCred(f.status.key)}
                onClear={() => handleClearCred(f.status.key)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
