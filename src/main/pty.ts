import * as pty from 'node-pty';
import { EventEmitter } from 'events';
import { SessionState } from './types';

// Strip ANSI escape sequences so string matching works on plain text
const ANSI_RE = /\x1b(?:\[[0-9;?]*[a-zA-Z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][0-9A-Za-z]|.)/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

export class PtySession extends EventEmitter {
  readonly id: string;
  private ptyProcess: pty.IPty | null = null;
  private state: SessionState = 'idle';

  constructor(id: string) {
    super();
    this.id = id;
  }

  spawn(workingDir: string, sessionId: string, extraArgs: string[] = []): void {
    const args = [
      '--session-id', sessionId,
      '--banner',
      ...extraArgs,
    ];

    this.ptyProcess = pty.spawn('copilot', args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 36,
      cwd: workingDir,
      env: process.env as Record<string, string>,
    });

    this.ptyProcess.onData((data: string) => {
      this.emit('data', data);
      this.detectState(data);
    });

    this.ptyProcess.onExit(() => {
      this.emit('died');
    });
  }

  write(data: string): void {
    this.ptyProcess?.write(data);
  }

  resize(cols: number, rows: number): void {
    this.ptyProcess?.resize(cols, rows);
  }

  kill(): void {
    if (this.ptyProcess) {
      try { this.ptyProcess.kill(); } catch { /* already dead */ }
      this.ptyProcess = null;
    }
  }

  getState(): SessionState {
    return this.state;
  }

  isAlive(): boolean {
    return this.ptyProcess !== null;
  }

  private detectState(data: string): void {
    const plain = stripAnsi(data);
    if (plain.includes('esc cancel')) {
      this.setState('running');
    } else if (plain.includes('enter to select') || plain.includes('enter to confirm') || plain.includes('Asking user')) {
      this.setState('awaiting');
    } else if (this.state === 'running' && plain.includes('❯')) {
      // Only go idle from running state when the input prompt appears
      this.setState('idle');
    }
  }

  private setState(newState: SessionState): void {
    if (this.state !== newState) {
      this.state = newState;
      this.emit('stateChange', newState);
    }
  }
}
