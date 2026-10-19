import React, { useState } from 'react';

interface Props {
  title: string;
  /** Resolves to whether the save succeeded; on failure the typed text stays. */
  onSave: (title: string) => Promise<boolean>;
  onClose: () => void;
}

export default function PrTitleEditor({ title, onSave, onClose }: Props): React.ReactElement {
  const [value, setValue] = useState(title);
  const [saving, setSaving] = useState(false);

  const trimmed = value.trim();
  const canSave = trimmed.length > 0 && trimmed !== title.trim() && !saving;

  const save = async (): Promise<void> => {
    if (!canSave) return;
    setSaving(true);
    try {
      if (await onSave(trimmed)) onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <span className="pr-viewer__title-edit">
      <input
        className="pr-viewer__title-input"
        value={value}
        disabled={saving}
        autoFocus
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            void save();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
      />
      <button className="btn btn--micro" disabled={saving} onClick={onClose}>CANCEL</button>
      <button className="btn btn--micro btn--primary" disabled={!canSave} onClick={() => void save()}>
        SAVE
      </button>
    </span>
  );
}
