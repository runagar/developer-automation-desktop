import * as pty from 'node-pty';
import { BrowserWindow } from 'electron';
import {
  shellTmuxSessionName, hasTmuxSession, createShellTmuxSession,
  killTmuxSession, requireTmux,
} from './tmux';

interface ShellAttachment {
  ptyProcess: pty.IPty;
  sessionId: string;
  panelInstanceId: string;
  tmuxName: string;
}

/**
 * ShellTmuxManager manages tmux-backed shell sessions.
 *
 * Each app session can have one shell tmux session. Multiple panel instances
 * can attach to the same tmux session (dual-attach for Default + linked).
 * Attachments are keyed by panelInstanceId.
 */
export class ShellTmuxManager {
  private attachments: Map<string, ShellAttachment> = new Map();
  private window: BrowserWindow | null = null;

  setWindow(win: BrowserWindow | null): void {
    this.window = win;
  }

  /**
   * Attach a panel instance to a session's shell tmux.
   * Creates the tmux session if it doesn't exist yet.
   */
  async attach(
    sessionId: string,
    panelInstanceId: string,
    workingDir: string,
    cols = 120,
    rows = 36,
  ): Promise<void> {
    await requireTmux();

    // Detach existing attachment for this panel instance if any
    this.detach(panelInstanceId);

    const tmuxName = shellTmuxSessionName(sessionId);
    const tmuxExists = await hasTmuxSession(tmuxName);

    if (!tmuxExists) {
      await createShellTmuxSession(sessionId, workingDir);
    }

    const proc = pty.spawn('tmux', ['attach-session', '-t', tmuxName], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: workingDir,
      env: process.env as Record<string, string>,
    });

    const attachment: ShellAttachment = {
      ptyProcess: proc,
      sessionId,
      panelInstanceId,
      tmuxName,
    };

    this.attachments.set(panelInstanceId, attachment);

    proc.onData((data: string) => {
      this.window?.webContents.send('shell:data', panelInstanceId, data);
    });

    proc.onExit(() => {
      this.attachments.delete(panelInstanceId);
      // Check if the tmux session is still alive — if not, it exited
      void hasTmuxSession(tmuxName)
        .then((exists) => {
          if (!exists) {
            this.window?.webContents.send('shell:exit', panelInstanceId);
          }
        })
        .catch(() => {
          this.window?.webContents.send('shell:exit', panelInstanceId);
        });
    });
  }

  /**
   * Detach a panel instance's PTY (keeps tmux running).
   */
  detach(panelInstanceId: string): void {
    const att = this.attachments.get(panelInstanceId);
    if (!att) return;
    try { att.ptyProcess.kill(); } catch { /* already dead */ }
    this.attachments.delete(panelInstanceId);
  }

  /**
   * Detach all panel instances attached to a session's shell tmux.
   */
  detachAllForSession(sessionId: string): void {
    for (const [pid, att] of this.attachments) {
      if (att.sessionId === sessionId) {
        try { att.ptyProcess.kill(); } catch { /* ok */ }
        this.attachments.delete(pid);
      }
    }
  }

  /**
   * Permanently destroy a session's shell tmux session.
   */
  async destroy(sessionId: string): Promise<void> {
    this.detachAllForSession(sessionId);
    await killTmuxSession(shellTmuxSessionName(sessionId));
  }

  write(panelInstanceId: string, data: string): void {
    this.attachments.get(panelInstanceId)?.ptyProcess.write(data);
  }

  resize(panelInstanceId: string, cols: number, rows: number): void {
    this.attachments.get(panelInstanceId)?.ptyProcess.resize(cols, rows);
  }

  killAll(): void {
    for (const [, att] of this.attachments) {
      try { att.ptyProcess.kill(); } catch { /* ok */ }
    }
    this.attachments.clear();
  }
}
