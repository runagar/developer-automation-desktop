import React from 'react';
import { cn } from '../utils/cn';
import './BranchPair.css';

interface BranchPairProps {
  head: string;
  base: string;
  /** Context styling (size, placement) supplied by the host panel. */
  className?: string;
}

/**
 * `<source> → <target>` — the single place the branch pair is formatted, so
 * the list rows and the viewer header can never drift apart.
 */
export default function BranchPair({ head, base, className }: BranchPairProps): React.ReactElement | null {
  if (!head || !base) return null;
  const text = `${head} → ${base}`;
  return <span className={cn('branch-pair', className)} title={text}>{text}</span>;
}
