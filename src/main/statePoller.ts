import { SessionState } from './types';
import { tmuxSessionName, listSmithSessions, capturePane, ANSI_RE } from './tmux';

export class StatePoller {
  private interval: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private readonly pollMs: number;
  private getSessionIds: () => { id: string; state: SessionState }[];
  private onStateChange: (id: string, state: SessionState) => void;
  private onDied: (id: string) => void;
  private onReap: (liveNames?: Set<string>) => Promise<void>;

  constructor(opts: {
    pollMs: number;
    getSessionIds: () => { id: string; state: SessionState }[];
    onStateChange: (id: string, state: SessionState) => void;
    onDied: (id: string) => void;
    onReap: (liveNames?: Set<string>) => Promise<void>;
  }) {
    this.pollMs = opts.pollMs;
    this.getSessionIds = opts.getSessionIds;
    this.onStateChange = opts.onStateChange;
    this.onDied = opts.onDied;
    this.onReap = opts.onReap;
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => {
      void this.poll();
    }, this.pollMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const sessions = this.getSessionIds();
      let liveNames: Set<string> | undefined;

      if (sessions.length > 0) {
        const liveTmux = await listSmithSessions();
        liveNames = new Set(liveTmux.map((s) => s.name));

        const alive: { id: string; state: SessionState; tmuxName: string }[] = [];
        for (const sess of sessions) {
          const tmuxName = tmuxSessionName(sess.id);
          if (!liveNames.has(tmuxName)) {
            this.onDied(sess.id);
          } else {
            alive.push({ ...sess, tmuxName });
          }
        }

        const captures = await Promise.all(
          alive.map(async (sess) => {
            const content = await capturePane(sess.tmuxName);
            return { ...sess, content };
          })
        );

        for (const { id, state, content } of captures) {
          if (!content) continue;
          const newState = detectStateFromPane(content);
          if (newState && newState !== state) {
            this.onStateChange(id, newState);
          }
        }
      }

      // Always reap, even with no pollable sessions — otherwise a user whose
      // sessions are all archived would never have them demoted to cold.
      // Reuse the tmux listing above when we already have it.
      await this.onReap(liveNames);
    } catch (error) {
      console.error('[StatePoller] Poll failed', error);
    } finally {
      this.polling = false;
    }
  }
}

/**
 * Every copilot CLI state is identified by the hint bar it draws in the bottom
 * few rows of the pane. Only ever match against that region (`CHROME_LINES`) —
 * copilot's own output and thinking text quotes these same strings verbatim,
 * so scanning further up produces false positives.
 *
 *   awaiting  a modal replaces the whole prompt chrome with its own hint bar,
 *             e.g. "↑/↓ select · enter accept · ctrl+d decline · esc cancel"
 *   running   "◎ Working · 11.5 KiB esc interrupt"
 *   idle      "← open sidebar · / commands · ? help · tab next tab"
 *
 * The `/ commands` hint is the only idle entry present in every variant — the
 * `? help` hint is dropped in autopilot mode and `tab next tab` in single-tab
 * sessions. There is deliberately no `❯` fallback for pre-1.0.82 builds: the
 * current UI draws `❯` in front of the selected option of a modal, so matching
 * it reported awaiting sessions as idle.
 */
const CHROME_LINES = 5;
const AWAITING_MARKERS = [
  'enter to select',
  'enter to submit',
  'enter to confirm',
  'enter to continue',
  'enter accept', // elicitation form ("Copilot needs information")
  'ctrl+d decline', // elicitation form
  'enter select', // "Approve inference request?"
  'enter Allow', // tool permission prompt
];
const RUNNING_MARKER = 'esc interrupt';
const IDLE_MARKER = '/ commands';

export function detectStateFromPane(content: string): SessionState | null {
  const plain = content.replace(ANSI_RE, '');
  const lines = plain.split('\n');
  // Strip trailing empty lines — suspended copilot sessions show the message
  // near the top with empty rows filling the rest of the pane.
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  // Suspended has no hint bar at all, so it needs a wider window than the rest.
  const tail = lines.slice(-12).join('\n');
  const chrome = lines.slice(-CHROME_LINES).join('\n');

  if (tail.includes('Copilot has been suspended')) return 'suspended';
  // Awaiting first: a modal hides the working/prompt footer, but the reverse is
  // not guaranteed, so a visible dialog must always win.
  if (AWAITING_MARKERS.some((marker) => chrome.includes(marker))) return 'awaiting';
  if (chrome.includes(RUNNING_MARKER)) return 'running';
  if (chrome.includes(IDLE_MARKER)) return 'idle';
  return null;
}
