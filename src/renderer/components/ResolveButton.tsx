import React from 'react';
import { MessageSquareCheck, MessageSquareOff } from 'lucide-react';

interface Props {
  className: string;
  resolved: boolean;
  title?: string;
  onClick: () => void;
}

export default function ResolveButton({ className, resolved, title, onClick }: Props): React.ReactElement {
  return (
    <button className={className} title={title ?? (resolved ? 'Unresolve' : 'Resolve')} onClick={onClick}>
      {resolved ? <MessageSquareOff size={16} /> : <MessageSquareCheck size={16} />}
    </button>
  );
}
