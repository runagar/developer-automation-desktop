import { SessionState } from './types';
import { tmuxSessionName, listSmithSessions, capturePane } from './tmux';

const ANSI_RE = /\x1b(?:\[[0-9;?]*[a-zA-Z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][0-9A-Za-z]|.)/g;

export class StatePoller {
  private interval: ReturnType<typeof setInterval> | null = null;
  private readonly pollMs: number;
  private getSessionIds: () => { id: string; state: SessionState }[];
  private onStateChange: (id: string, state: SessionState) => void;
  private onDied: (id: string) => void;

  constructor(opts: {
    pollMs: number;
    getSessionIds: () => { id: string; state: SessionState }[];
    onStateChange: (id: string, state: SessionState) => void;
    onDied: (id: string) => void;
  }) {
    this.pollMs = opts.pollMs;
    this.getSessionIds = opts.getSessionIds;
    this.onStateChange = opts.onStateChange;
    this.onDied = opts.onDied;
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
    try {
      const sessions = this.getSessionIds();
      if (sessions.length === 0) return;

      const liveTmux = await listSmithSessions();
      const liveNames = new Set(liveTmux.map((s) => s.name));

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
    } catch (error) {
      console.error('[StatePoller] Poll failed', error);
    }
  }
}

function detectStateFromPane(content: string): SessionState | null {
  const plain = content.replace(ANSI_RE, '');
  if (plain.includes('Copilot has been suspended')) return 'suspended';
  if (plain.includes('esc cancel')) return 'running';
  if (plain.includes('enter to select') || plain.includes('enter to confirm') || plain.includes('Asking user')) return 'awaiting';
  if (plain.includes('❯')) return 'idle';
  return null;
}
