import React from 'react';
import { SessionState } from '../../main/types';
import './StateIndicator.css';

type DisplayState = SessionState | 'dead' | 'warm' | 'cold';

interface Props {
  state: DisplayState;
}

const LABELS: Record<DisplayState, string> = {
  idle: 'IDLE',
  running: 'RUN',
  awaiting: 'INPUT',
  suspended: 'SUSPENDED',
  dead: 'DEAD',
  warm: 'WARM',
  cold: 'COLD',
};

const TITLES: Partial<Record<DisplayState, string>> = {
  warm: 'Archived — agent still loaded, restores instantly',
  cold: 'Archived — agent unloaded, restore takes a few seconds',
};

export default function StateIndicator({ state }: Props): React.ReactElement {
  return (
    <span
      className={`state-indicator state-indicator--${state}`}
      title={TITLES[state] ?? state.toUpperCase()}
    >
      <span className="state-indicator__dot" />
      <span className="state-indicator__label">{LABELS[state]}</span>
    </span>
  );
}
