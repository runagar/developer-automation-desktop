import React from 'react';
import { CredentialStatusInfo } from '../../main/types';
import './CredentialsDialog.css';

export interface FieldState {
  status: CredentialStatusInfo;
  editedValue: string | null;
  showValue: boolean;
  saving: boolean;
  error: string | null;
  saved: boolean;
}

export interface CredentialRowProps {
  field: FieldState;
  onEdit: (value: string) => void;
  onToggleShow: () => void;
  onSave: () => void;
  onClear: () => void;
}

export default function CredentialRow({ field, onEdit, onToggleShow, onSave, onClear }: CredentialRowProps): React.ReactElement {
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
