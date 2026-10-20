import React from 'react';
import { PenLine } from 'lucide-react';

interface Props {
  className: string;
  title?: string;
  size?: number;
  onClick: () => void;
}

export default function EditButton(
  { className, title = 'Edit this comment', size = 16, onClick }: Props
): React.ReactElement {
  return (
    <button className={className} title={title} onClick={onClick}>
      <PenLine size={size} />
    </button>
  );
}
