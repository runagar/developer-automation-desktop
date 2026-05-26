import React, { useEffect, useRef } from 'react';
import './ConfirmDialog.css';

interface Props {
  message: string;
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  message,
  detail,
  confirmLabel = 'CONFIRM',
  cancelLabel = 'CANCEL',
  onConfirm,
  onCancel,
}: Props): React.ReactElement {
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Focus the safe (cancel) button by default so Enter/Space don't accidentally confirm.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onCancel]);

  return (
    <div className="confirm-overlay" onClick={onCancel}>
      <div
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-msg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="confirm-dialog__header">⚠ CONFIRM ACTION</div>
        <p id="confirm-msg" className="confirm-dialog__message">{message}</p>
        {detail && <p className="confirm-dialog__detail">{detail}</p>}
        <div className="confirm-dialog__actions">
          <button
            className="btn btn--danger confirm-dialog__btn"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
          <button
            ref={cancelRef}
            className="btn confirm-dialog__btn"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
