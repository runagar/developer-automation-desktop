import * as pty from 'node-pty';
import { BrowserWindow } from 'electron';

/**
 * ShellManager manages one standalone shell PTY per session.
 *
 * Unlike PtySession (which attaches to tmux for copilot), these are plain
 * interactive shells spawned via node-pty. They do not persist across
 * app restarts and are not tied to tmux.
 */
export class ShellManager {
  private shells: Map<string, pty.IPty> = new Map();
  private workingDirs: Map<string, string> = new Map();
  private killedIds: Set<string> = new Set();
  private window: BrowserWindow | null = null;

  // Auto-respawn guard: track recent exits per session
  private exitTimestamps: Map<string, number[]> = new Map();
  private static readonly MAX_RESPAWNS = 3;
  private static readonly RESPAWN_WINDOW_MS = 5000;

  setWindow(win: BrowserWindow | null): void {
    this.window = win;
  }

  spawn(sessionId: string, workingDir: string): void {
    // Kill existing shell for this session if any
    if (this.shells.has(sessionId)) {
      this.kill(sessionId);
    }

    this.killedIds.delete(sessionId);
    this.workingDirs.set(sessionId, workingDir);

    const shell = process.env.SHELL || '/bin/bash';
    const env = this.cleanEnv();

    const proc = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: workingDir,
      env,
    });

    this.shells.set(sessionId, proc);

    proc.onData((data: string) => {
      this.window?.webContents.send('shell:data', sessionId, data);
    });

    proc.onExit(() => {
      this.shells.delete(sessionId);

      // Don't respawn if intentionally killed
      if (this.killedIds.has(sessionId)) {
        this.killedIds.delete(sessionId);
        return;
      }

      this.window?.webContents.send('shell:exit', sessionId);

      // Auto-respawn with guard
      if (this.shouldRespawn(sessionId)) {
        const dir = this.workingDirs.get(sessionId);
        if (dir) this.spawn(sessionId, dir);
      }
    });
  }

  write(sessionId: string, data: string): void {
    this.shells.get(sessionId)?.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.shells.get(sessionId)?.resize(cols, rows);
  }

  kill(sessionId: string): void {
    this.killedIds.add(sessionId);
    const proc = this.shells.get(sessionId);
    if (proc) {
      try { proc.kill(); } catch { /* already dead */ }
      this.shells.delete(sessionId);
    }
    this.workingDirs.delete(sessionId);
    this.exitTimestamps.delete(sessionId);
  }

  killAll(): void {
    for (const id of [...this.shells.keys()]) {
      this.kill(id);
    }
  }

  private shouldRespawn(sessionId: string): boolean {
    const now = Date.now();
    const timestamps = this.exitTimestamps.get(sessionId) ?? [];
    timestamps.push(now);

    // Keep only timestamps within the window
    const recent = timestamps.filter(
      (t) => now - t < ShellManager.RESPAWN_WINDOW_MS
    );
    this.exitTimestamps.set(sessionId, recent);

    if (recent.length > ShellManager.MAX_RESPAWNS) {
      console.warn(
        `[ShellManager] Shell for session ${sessionId} exited ${recent.length} times ` +
        `in ${ShellManager.RESPAWN_WINDOW_MS}ms — stopping auto-respawn`
      );
      return false;
    }
    return true;
  }

  private cleanEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      if (
        key === 'ELECTRON_RUN_AS_NODE' ||
        key === 'ELECTRON_NO_ASAR' ||
        key === 'ELECTRON_ENABLE_LOGGING' ||
        key.startsWith('ELECTRON_')
      ) continue;
      env[key] = value;
    }
    return env;
  }
}
