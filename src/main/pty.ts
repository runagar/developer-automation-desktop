import * as pty from 'node-pty';
import { EventEmitter } from 'events';
import {
  tmuxSessionName, hasTmuxSession, createTmuxSession,
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

  constructor(id: string) {
    super();
    this.id = id;
    this.tmuxName = tmuxSessionName(id);
  }

  /**
   * Spawn or reattach to a tmux session.
   * @param workingDir  working directory for copilot (only used when creating)
   * @param sessionId   the UUID for copilot --session-id
   * @param tmuxExists  if true, skip tmux creation (session already running)
   */
  async spawn(workingDir: string, sessionId: string, tmuxExists = false, cols = 120, rows = 36): Promise<void> {
    await requireTmux();

    if (!tmuxExists) {
      await createTmuxSession(sessionId, workingDir);
    }

    this.intentionalDetach = false;
    this.ptyProcess = pty.spawn('tmux', ['attach-session', '-t', this.tmuxName], {
      name: 'xterm-256color',
      cols,
      rows,
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
    this.ptyProcess?.resize(cols, rows);
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
