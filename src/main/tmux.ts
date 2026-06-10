import { execFileSync } from 'child_process';

const ANSI_RE = /\x1b(?:\[[0-9;?]*[a-zA-Z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][0-9A-Za-z]|.)/g;

export function tmuxSessionName(sessionId: string): string {
  return `smith-${sessionId.slice(0, 12)}`;
}

export function hasTmuxSession(name: string): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function createTmuxSession(sessionId: string, workingDir: string): string {
  const name = tmuxSessionName(sessionId);

  if (hasTmuxSession(name)) {
    console.log(`[tmux] Session ${name} already exists, reusing`);
    configureTmuxSession(name);
    return name;
  }

  console.log(`[tmux] Creating session ${name} for copilot --session-id ${sessionId}`);

  execFileSync('tmux', [
    'new-session', '-d',
    '-s', name,
    '-x', '120',
    '-y', '40',
    '-c', workingDir,
    '--',
    'copilot', '--session-id', sessionId, '--banner',
  ], {
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    stdio: 'ignore',
  });

  configureTmuxSession(name);
  console.log(`[tmux] Session ${name} created`);
  return name;
}

export function killTmuxSession(name: string): void {
  if (!hasTmuxSession(name)) return;
  console.log(`[tmux] Killing session ${name}`);
  try {
    execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' });
  } catch { /* already dead */ }
}

function configureTmuxSession(name: string): void {
  const setOption = (key: string, value: string) => {
    try {
      execFileSync('tmux', ['set-option', '-t', name, key, value], { stdio: 'ignore' });
    } catch { /* non-fatal */ }
  };
  setOption('mouse', 'on');
  setOption('status', 'off');
  setOption('history-limit', '50000');
  setOption('allow-passthrough', 'on');
  setOption('set-clipboard', 'on');
}

/**
 * Capture the current visible pane content (stripped of ANSI escapes).
 * Used for state detection polling.
 */
export function capturePane(name: string): string {
  try {
    const raw = execFileSync('tmux', ['capture-pane', '-t', name, '-p'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return raw.replace(ANSI_RE, '');
  } catch {
    return '';
  }
}

/**
 * Capture the entire scrollback buffer (with ANSI escapes preserved).
 * Used on reattach to replay history into xterm.
 */
export function capturePaneFullScrollback(name: string): string {
  try {
    return execFileSync('tmux', ['capture-pane', '-t', name, '-p', '-S', '-'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch {
    return '';
  }
}

/**
 * Query tmux session metadata.
 * Returns last activity epoch (seconds) and number of attached clients.
 */
export function getSessionInfo(name: string): { activity: number; attached: number } | null {
  try {
    const output = execFileSync(
      'tmux',
      ['display-message', '-t', name, '-p', '#{session_activity} #{session_attached}'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    const [actStr, attStr] = output.split(' ');
    return { activity: parseInt(actStr, 10) || 0, attached: parseInt(attStr, 10) || 0 };
  } catch {
    return null;
  }
}

/**
 * List all smith-* tmux sessions with metadata.
 */
export function listSmithSessions(): Array<{ name: string; activity: number; attached: number }> {
  try {
    const output = execFileSync(
      'tmux',
      ['list-sessions', '-F', '#{session_name} #{session_activity} #{session_attached}'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    if (!output) return [];
    return output
      .split('\n')
      .filter((line) => line.startsWith('smith-'))
      .map((line) => {
        const [name, actStr, attStr] = line.split(' ');
        return { name, activity: parseInt(actStr, 10) || 0, attached: parseInt(attStr, 10) || 0 };
      });
  } catch {
    return [];
  }
}

/**
 * Check if tmux is installed. Throws a descriptive error if not.
 */
export function requireTmux(): void {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
  } catch {
    throw new Error(
      'tmux is not installed. Agent Smith requires tmux for session persistence. ' +
      'Install it with: sudo apt-get install tmux'
    );
  }
}
