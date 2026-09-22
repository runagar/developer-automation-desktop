import React, { useEffect, useRef } from 'react';
import { useEscape } from '../hooks/useEscape';
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

  // Escape cancels. Shared so every dialog and popover consumes the key the
  // same way; this one previously listened in the bubble phase and let it
  // through to whatever was behind the modal.
  useEscape(true, onCancel);

  return (
    <div className="dialog-overlay" onClick={onCancel}>
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
