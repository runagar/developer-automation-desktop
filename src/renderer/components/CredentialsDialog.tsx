import React, { useEffect, useState, useCallback, useRef } from 'react';
import { CredentialStatusInfo } from '../../main/types';
import './CredentialsDialog.css';

interface Props {
  onClose: () => void;
}

interface FieldState {
  status: CredentialStatusInfo;
  editedValue: string | null;   // null = not edited
  showValue: boolean;
  saving: boolean;
  error: string | null;
  saved: boolean;
}

export default function CredentialsDialog({ onClose }: Props): React.ReactElement {
  const [fields, setFields] = useState<FieldState[]>([]);
  const [loading, setLoading] = useState(true);
  const overlayRef = useRef<HTMLDivElement>(null);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const statuses = await window.agentSmith.getCredentialStatus();
      setFields(statuses.map((s) => ({
        status: s,
        editedValue: null,
        showValue: false,
        saving: false,
        error: null,
        saved: false,
      })));
    } catch {
      // non-fatal
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadStatus(); }, [loadStatus]);

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

  const updateField = (key: string, patch: Partial<FieldState>) => {
    setFields((prev) => prev.map((f) =>
      f.status.key === key ? { ...f, ...patch } : f
    ));
  };

  const handleSave = useCallback(async (key: string) => {
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

  const handleClear = useCallback(async (key: string) => {
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
    } catch {
      // non-fatal
    }
  }, [fields]);

  // Group fields by group name
  const groups = new Map<string, FieldState[]>();
  for (const f of fields) {
    const g = groups.get(f.status.group) ?? [];
    g.push(f);
    groups.set(f.status.group, g);
  }

  return (
    <div className="credentials-overlay" ref={overlayRef} onClick={handleOverlayClick}>
      <div className="credentials-dialog">
        <div className="credentials-dialog__header">
          <span className="credentials-dialog__title">CREDENTIALS</span>
          <button className="btn btn--micro" onClick={onClose}>✕</button>
        </div>

        <div className="credentials-dialog__body">
          {loading && <div className="credentials-dialog__loading">Loading…</div>}

          {!loading && Array.from(groups.entries()).map(([group, groupFields]) => (
            <div key={group} className="credentials-dialog__group">
              <div className="credentials-dialog__group-label">{group}</div>
              {groupFields.map((f) => (
                <CredentialRow
                  key={f.status.key}
                  field={f}
                  onEdit={(val) => updateField(f.status.key, { editedValue: val, saved: false, error: null })}
                  onToggleShow={() => updateField(f.status.key, { showValue: !f.showValue })}
                  onSave={() => handleSave(f.status.key)}
                  onClear={() => handleClear(f.status.key)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

interface CredentialRowProps {
  field: FieldState;
  onEdit: (value: string) => void;
  onToggleShow: () => void;
  onSave: () => void;
  onClear: () => void;
}

function CredentialRow({ field, onEdit, onToggleShow, onSave, onClear }: CredentialRowProps): React.ReactElement {
  const { status, editedValue, showValue, saving, error, saved } = field;
  const isEnv = status.source === 'env';
  const displayValue = editedValue ?? status.value;
  const isEdited = editedValue !== null;
  const isEmpty = !displayValue && status.source === 'none';

  const inputType = status.sensitive && !showValue ? 'password' : 'text';

  return (
    <div className="credentials-dialog__row">
      <div className="credentials-dialog__field-header">
        <label className="credentials-dialog__label">{status.label}</label>
        <span className="credentials-dialog__key">{status.key}</span>
      </div>

      <div className="credentials-dialog__field-body">
        <input
          className={`credentials-dialog__input${isEnv ? ' credentials-dialog__input--env' : ''}${error ? ' credentials-dialog__input--error' : ''}`}
          type={inputType}
          value={displayValue}
          onChange={(e) => onEdit(e.target.value)}
          placeholder={status.placeholder ?? ''}
          disabled={isEnv}
          spellCheck={false}
        />

        {status.sensitive && !isEnv && (
          <button
            className="btn btn--micro credentials-dialog__toggle"
            onClick={onToggleShow}
            title={showValue ? 'Hide' : 'Show'}
          >
            {showValue ? '🙈' : '👁'}
          </button>
        )}

        {isEdited && !isEnv && (
          <button
            className="btn btn--micro credentials-dialog__save-btn"
            onClick={onSave}
            disabled={saving}
          >
            {saving ? '…' : 'SAVE'}
          </button>
        )}

        {!isEdited && status.source === 'file' && (
          <button
            className="btn btn--micro credentials-dialog__clear-btn"
            onClick={onClear}
            title="Clear credential"
          >
            ✕
          </button>
        )}
      </div>

      <div className="credentials-dialog__field-status">
        {isEnv && <span className="credentials-dialog__env-note">Set via environment variable</span>}
        {isEmpty && status.required && <span className="credentials-dialog__required">Required</span>}
        {error && <span className="credentials-dialog__error">{error}</span>}
        {saved && <span className="credentials-dialog__saved">✓ Saved</span>}
      </div>
    </div>
  );
}
