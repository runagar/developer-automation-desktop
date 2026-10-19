import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useGitHubStore } from '../stores/githubStore';
import { cn } from '../utils/cn';
import CommentComposer from './CommentComposer';

interface Props {
  /** The GitHub node whose text this is — the key of its edit session. */
  id: string;
  body: string;
  bodyClassName: string;
  /** Resolves to whether the save succeeded; the store ends the edit on success. */
  onSave: (body: string) => Promise<boolean>;
  allowEmpty?: boolean;
  /** Shown, dimmed, in place of an empty body. */
  emptyText?: string;
}

export default function EditableMarkdown({
  id, body, bodyClassName, onSave, allowEmpty, emptyText,
}: Props): React.ReactElement | null {
  const editText = useGitHubStore((s) => s.edits[id]);
  const setEdit = useGitHubStore((s) => s.setEdit);
  const endEdit = useGitHubStore((s) => s.endEdit);

  if (editText !== undefined) {
    return (
      <CommentComposer
        value={editText}
        onChange={(text) => setEdit(id, text)}
        original={body}
        allowEmpty={allowEmpty}
        placeholder="Edit…  (Ctrl+Enter to save, Esc to cancel)"
        submitLabel="SAVE"
        autoFocus
        onSubmit={onSave}
        onCancel={() => endEdit(id)}
      />
    );
  }

  if (!body) {
    return emptyText ? <div className={cn(bodyClassName, `${bodyClassName}--empty`)}>{emptyText}</div> : null;
  }

  return (
    <div className={cn(bodyClassName, 'markdown-body')}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
    </div>
  );
}
