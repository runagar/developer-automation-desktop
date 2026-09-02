import { describe, it, expect } from 'vitest';
import { detectStateFromPane } from './statePoller';

/**
 * Fixtures are trimmed captures of real `tmux capture-pane -p` output from
 * copilot CLI 1.0.82, which replaced the bare `❯` prompt with a boxed input
 * plus a hint-bar footer.
 */
const INPUT_BOX = ['╻▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄', '┃', '╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀'].join('\n');
const RULE = '─'.repeat(40);

function pane(...lines: string[]): string {
  return lines.join('\n');
}

describe('detectStateFromPane', () => {
  it('detects idle from the current hint-bar footer', () => {
    const content = pane(
      ' ● Tip: /usage',
      ' ~/projects/nic [⎇ main]                       Session: 183.32 AIC used',
      INPUT_BOX,
      ' ← open sidebar · / commands · ? help · tab next tab      Claude Opus 5 · 1M context',
      '',
      ''
    );
    expect(detectStateFromPane(content)).toBe('idle');
  });

  it('detects idle in autopilot mode, where the ? help hint is dropped', () => {
    const content = pane(
      ' ~/projects/nic [⎇ main*]                      Session: 447.12 AIC used',
      INPUT_BOX,
      ' ← open sidebar · autopilot · / commands · tab next tab   Claude Opus 5 · 1M context'
    );
    expect(detectStateFromPane(content)).toBe('idle');
  });

  it('detects running from the working footer', () => {
    const content = pane(
      ' ⌄ Thinking…',
      ' ~/projects/nic [⎇ main]                       Session: 29928.84 AIC used',
      INPUT_BOX,
      ' ◎ Working · 11.5 KiB esc interrupt                       Claude Opus 5 · 1M context'
    );
    expect(detectStateFromPane(content)).toBe('running');
  });

  it('detects awaiting from the elicitation form hint bar', () => {
    const content = pane(
      ' Ready:',
      ' Any option is fine — this is only here to hold the awaiting state open.',
      ' ❯ Submitting now',
      '   Held it open for 15s',
      '   Other (type your answer)',
      '',
      ' ↑/↓ select · enter accept · ctrl+d decline · esc cancel',
      RULE
    );
    expect(detectStateFromPane(content)).toBe('awaiting');
  });

  it('detects awaiting from an option-list dialog', () => {
    const content = pane(
      ' Approve inference request?',
      ' ❯ Yes',
      '   No',
      ' up-down to navigate · enter to select · esc to cancel'
    );
    expect(detectStateFromPane(content)).toBe('awaiting');
  });

  it('does not report idle while a modal draws ❯ in front of the selected option', () => {
    // Regression: the old `❯` fallback matched the selected form option, so an
    // awaiting session was reported as idle.
    const content = pane(
      ' ❯ Submitting now',
      '   Held it open for 15s',
      '',
      ' ↑/↓ select · enter accept · ctrl+d decline · esc cancel',
      RULE
    );
    expect(detectStateFromPane(content)).not.toBe('idle');
  });

  it('detects suspended with a mostly empty pane below the message', () => {
    const content = pane('Copilot has been suspended', '', '', '', '', '', '', '', '', '', '', '', '', '');
    expect(detectStateFromPane(content)).toBe('suspended');
  });

  it('ignores markers quoted in agent output above the chrome', () => {
    const content = pane(
      ' The form hint bar reads "enter accept · ctrl+d decline".',
      ' ~/projects/nic [⎇ main]                       Session: 30155.74 AIC used',
      INPUT_BOX,
      ' ● Working · 11.7 KiB esc interrupt                       Claude Opus 5 · 1M context'
    );
    expect(detectStateFromPane(content)).toBe('running');
  });

  it('returns null when no marker is present', () => {
    expect(detectStateFromPane(pane('just some output', 'and more'))).toBeNull();
  });
});
