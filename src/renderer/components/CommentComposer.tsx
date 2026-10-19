import React, { useEffect, useRef, useState } from 'react';
import { useGitHubStore } from '../stores/githubStore';

interface Props {
  /**
   * Identity of this composer's draft, so unsent text survives the body being
   * unmounted by a subtab switch. Omit for a composer whose text is not worth
   * keeping.
   */
  draftKey?: string;
  /**
   * Seed text, e.g. a quoted comment. Read once — remount with a new `key`
   * to seed it again, which is how "quote reply" replaces the draft.
   */
  initialBody?: string;
  placeholder: string;
  submitLabel: string;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Resolving to `false` reports the submit failed, so the text is kept for another try. */
  onSubmit: (body: string) => void | boolean | Promise<void | boolean>;
  onCancel?: () => void;
  /**
   * Controlled mode: the text is the caller's, with no local copy and no
   * draft hand-over. Used by edits, whose text must be live in the store.
   */
  value?: string;
  onChange?: (body: string) => void;
  /** The text being edited; submitting is disabled while it is unchanged. */
  original?: string;
  /** Lets an empty body be submitted — clearing a description, say. */
  allowEmpty?: boolean;
}

/**
 * A markdown comment box.
 *
 * Draft text is **local component state**, never the store: this component
 * lives inside the diff and the timeline, and publishing every keystroke to a
 * store shared with the file list and the PR header would re-render both
 * panels on each character.
 */
export default function CommentComposer({
  draftKey, initialBody, placeholder, submitLabel, disabled, autoFocus, onSubmit, onCancel,
  value, onChange, original, allowEmpty,
}: Props): React.ReactElement {
  // Read once, non-reactively: a draft restored here must not make this
  // component re-render whenever any other composer saves.
  const [localBody, setLocalBody] = useState(
    () => initialBody || (draftKey ? useGitHubStore.getState().drafts[draftKey] ?? '' : '')
  );
  const controlled = value !== undefined;
  const body = controlled ? value : localBody;
  const setBody = (next: string): void => {
    if (controlled) onChange?.(next);
    else setLocalBody(next);
  };
  const [sending, setSending] = useState(false);

  // The unmount cleanup runs once and would otherwise close over the body as
  // it was when the effect was created.
  const bodyRef = useRef(body);
  bodyRef.current = body;

  useEffect(() => {
    if (!draftKey) return undefined;
    // Hand the text over on the way out — which is what a subtab switch does.
    return () => useGitHubStore.getState().setDraft(draftKey, bodyRef.current.trim());
  }, [draftKey]);

  /**
   * Cancel means discard.
   *
   * The body is blanked *before* the parent unmounts this component, so the
   * cleanup above saves an empty draft rather than restoring the text the
   * user just dismissed.
   */
  const cancel = (): void => {
    bodyRef.current = '';
    setBody('');
    if (draftKey) useGitHubStore.getState().setDraft(draftKey, '');
    onCancel?.();
  };

  const trimmed = body.trim();
  const submittable = (trimmed.length > 0 || allowEmpty === true)
    && (original === undefined || trimmed !== original.trim());

  const send = async (fn: (body: string) => void | boolean | Promise<void | boolean>): Promise<void> => {
    if (!submittable || sending) return;
    setSending(true);
    try {
      if ((await fn(trimmed)) === false) return;
      if (controlled) return;
      setBody('');
      // Sent: the draft is no longer unfinished work.
      if (draftKey) useGitHubStore.getState().setDraft(draftKey, '');
    } finally {
      setSending(false);
    }
  };

  const busy = sending || disabled === true;

  return (
    <div className="pr-composer">
      <textarea
        className="pr-composer__input"
        value={body}
        placeholder={placeholder}
        disabled={busy}
        autoFocus={autoFocus}
        rows={3}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          // Enter must insert a newline — this is markdown. Ctrl+Enter sends.
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void send(onSubmit);
          }
          if (e.key === 'Escape' && onCancel) {
            e.preventDefault();
            cancel();
          }
          // The panel-level Tab handler must not steal focus out of a textarea.
          e.stopPropagation();
        }}
      />
      <div className="pr-composer__buttons">
        {onCancel && (
          <button className="btn btn--micro" onClick={cancel} disabled={sending}>CANCEL</button>
        )}
        <button
          className="btn btn--micro btn--primary"
          disabled={busy || !submittable}
          onClick={() => void send(onSubmit)}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
