import React from 'react';
import { SessionState } from '../../main/types';
import './StateIndicator.css';
import './StateIndicator.css';

type DisplayState = SessionState | 'dead';

interface Props {
  state: DisplayState;
}

const LABELS: Record<DisplayState, string> = {
  idle: 'IDLE',
  running: 'RUN',
  awaiting: 'INPUT',
  dead: 'DEAD',
};

export default function StateIndicator({ state }: Props): React.ReactElement {
  return (
    <span className={`state-indicator state-indicator--${state}`} title={state.toUpperCase()}>
      <span className="state-indicator__dot" />
      <span className="state-indicator__label">{LABELS[state]}</span>
    </span>
  );
}
