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

export function detectStateFromPane(content: string): SessionState | null {
  const plain = content.replace(ANSI_RE, '');
  // Only check the last portion of the pane for state indicators — all copilot
  // status chrome (prompt, status bar) appears at the bottom. Checking the full
  // pane risks false matches from copilot's own output/thinking text.
  const lines = plain.split('\n');
  // Strip trailing empty lines — suspended copilot sessions show the message
  // near the top with empty rows filling the rest of the pane.
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  const tail = lines.slice(-12).join('\n');

  if (tail.includes('Copilot has been suspended')) return 'suspended';
  if (tail.includes('enter to select') || tail.includes('enter to submit') || tail.includes('enter to confirm') || tail.includes('Asking user')) return 'awaiting';
  if (tail.includes('esc interrupt')) return 'running';
  if (tail.includes('❯')) return 'idle';
  return null;
}
