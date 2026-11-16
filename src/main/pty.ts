import * as pty from 'node-pty';
import { EventEmitter } from 'events';
import {
  tmuxSessionName, hasTmuxSession,
  requireTmux,
} from './tmux';

/**
 * PtySession manages a node-pty process that attaches to a tmux session.
 *
 * The copilot process runs inside tmux (child of tmux server), not Electron.
 * The PTY here is only the `tmux attach-session` client — it can be killed
 * and recreated freely without affecting the copilot process.
 *
 * State detection is handled externally by SessionManager via capturePane polling.
 */
export class PtySession extends EventEmitter {
  readonly id: string;
  readonly tmuxName: string;
  private ptyProcess: pty.IPty | null = null;
  private intentionalDetach = false;
  private pendingSize: { cols: number; rows: number } | null = null;

  constructor(id: string) {
    super();
    this.id = id;
    this.tmuxName = tmuxSessionName(id);
  }

  async spawn(workingDir: string, cols = 120, rows = 36): Promise<void> {
    await requireTmux();

    this.intentionalDetach = false;
    this.ptyProcess = pty.spawn('tmux', ['attach-session', '-t', this.tmuxName], {
      name: 'xterm-256color',
      cols: this.pendingSize?.cols ?? cols,
      rows: this.pendingSize?.rows ?? rows,
      cwd: workingDir,
      env: process.env as Record<string, string>,
    });

    this.ptyProcess.onData((data: string) => {
      this.emit('data', data);
    });

    this.ptyProcess.onExit(() => {
      this.ptyProcess = null;
      if (this.intentionalDetach) return;
      // Check if the tmux session is still alive — if not, copilot actually exited
      void hasTmuxSession(this.tmuxName)
        .then((exists) => {
          if (!exists) {
            this.emit('died');
          }
        })
        .catch(() => {
          this.emit('died');
        });
    });
  }

  write(data: string): void {
    this.ptyProcess?.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.ptyProcess) this.ptyProcess.resize(cols, rows);
    else this.pendingSize = { cols, rows };
  }

  /**
   * Kill only the attach PTY. The tmux session (and copilot) keeps running.
   * Used when archiving a session or shutting down the app.
   */
  kill(): void {
    this.intentionalDetach = true;
    if (this.ptyProcess) {
      try { this.ptyProcess.kill(); } catch { /* already dead */ }
      this.ptyProcess = null;
    }
  }

}
