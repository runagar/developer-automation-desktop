import React from 'react';
import { PenLine } from 'lucide-react';

interface Props {
  className: string;
  title?: string;
  onClick: () => void;
}

export default function EditButton({ className, title = 'Edit this comment', onClick }: Props): React.ReactElement {
  return (
    <button className={className} title={title} onClick={onClick}>
      <PenLine size={11} />
    </button>
  );
}
