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
  // Tail of the previous chunk, prepended to each new chunk so that
  // detection patterns split across a PTY chunk boundary are still matched.
  private chunkTail = '';
  private readonly TAIL_SIZE = 64;
  // Idle is only committed after the prompt has been visible for this long
  // with no further output, preventing false transitions during autocomplete.
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly IDLE_DELAY_MS = 5000;

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
    this.cancelIdleTimer();
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

  private cancelIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private detectState(data: string): void {
    const plain = stripAnsi(data);
    // Bridge chunk boundaries: prepend the tail of the previous chunk so a
    // pattern split across two chunks (e.g. "esc can" + "cel") is still matched.
    const window = this.chunkTail + plain;
    this.chunkTail = plain.slice(-this.TAIL_SIZE);

    // Any new output cancels a pending idle transition — the session is still active.
    this.cancelIdleTimer();

    if (window.includes('esc cancel')) {
      this.setState('running');
    } else if (window.includes('enter to select') || window.includes('enter to confirm') || window.includes('Asking user')) {
      this.setState('awaiting');
    } else if (this.state === 'running' && window.includes('❯')) {
      // Defer idle: only commit if no further output arrives within IDLE_DELAY_MS.
      // This prevents false transitions when '❯' appears mid-output (e.g. autocomplete).
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        this.setState('idle');
      }, this.IDLE_DELAY_MS);
    }
  }

  private setState(newState: SessionState): void {
    if (this.state !== newState) {
      this.state = newState;
      this.emit('stateChange', newState);
    }
  }
}
