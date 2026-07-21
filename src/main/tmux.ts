import { execFile } from 'child_process';

export const ANSI_RE = /\x1b(?:\[[0-9;?]*[a-zA-Z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][0-9A-Za-z]|.)/g;

function execTmux(args: string[], options?: { maxBuffer?: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'tmux',
      args,
      {
        encoding: 'utf-8' as BufferEncoding,
        ...options,
      },
      (err, stdout) => {
        if (err) reject(err);
        else resolve((stdout as string) ?? '');
      }
    );
  });
}

function execTmuxQuiet(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('tmux', args, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export function tmuxSessionName(sessionId: string): string {
  return `smith-${sessionId.slice(0, 12)}`;
}

export async function hasTmuxSession(name: string): Promise<boolean> {
  try {
    await execTmuxQuiet(['has-session', '-t', name]);
    return true;
  } catch {
    return false;
  }
}

export async function createTmuxSession(sessionId: string, workingDir: string): Promise<string> {
  const name = tmuxSessionName(sessionId);

  if (await hasTmuxSession(name)) {
    console.log(`[tmux] Session ${name} already exists, reusing`);
    await configureTmuxSession(name);
    return name;
  }

  console.log(`[tmux] Creating session ${name} for copilot --session-id ${sessionId}`);

  // Wrap copilot in the user's login-interactive shell so that PATH additions
  // from shell config files (.zshrc, .bashrc, etc.) are available — e.g. SDKMAN
  // (Java), pyenv, rbenv. We also explicitly trigger direnv (if installed) so
  // that per-project .envrc settings (e.g. Java/Maven version) are applied.
  // `exec` replaces the shell with copilot so that when copilot exits the tmux
  // window closes (preserving died-detection behaviour).
  const shell = process.env.SHELL || '/bin/bash';
  const copilotCmd = [
    'if command -v direnv >/dev/null 2>&1; then eval "$(direnv export zsh 2>/dev/null || direnv export bash 2>/dev/null)"; fi',
    `exec copilot --session-id ${sessionId} --banner`,
  ].join('; ');

  await new Promise<void>((resolve, reject) => {
    execFile(
      'tmux',
      [
        'new-session', '-d',
        '-s', name,
        '-x', '120',
        '-y', '40',
        '-c', workingDir,
        '--',
        shell, '-lic', copilotCmd,
      ],
      {
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      },
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });

  await configureTmuxSession(name);
  console.log(`[tmux] Session ${name} created`);
  return name;
}

export async function killTmuxSession(name: string): Promise<void> {
  if (!await hasTmuxSession(name)) return;
  console.log(`[tmux] Killing session ${name}`);
  try {
    await execTmuxQuiet(['kill-session', '-t', name]);
  } catch {
    // already dead
  }
}

async function configureTmuxSession(name: string): Promise<void> {
  const options: Array<[string, string]> = [
    ['mouse', 'on'],
    ['status', 'off'],
    ['history-limit', '50000'],
    ['allow-passthrough', 'on'],
    ['set-clipboard', 'on'],
  ];

  await Promise.all(
    options.map(async ([key, value]) => {
      try {
        await execTmuxQuiet(['set-option', '-t', name, key, value]);
      } catch {
        // non-fatal
      }
    })
  );
}

/**
 * Capture the current visible pane content (stripped of ANSI escapes).
 * Used for state detection polling.
 */
export async function capturePane(name: string): Promise<string> {
  try {
    const raw = await execTmux(['capture-pane', '-t', name, '-p']);
    return raw.replace(ANSI_RE, '');
  } catch {
    return '';
  }
}

/**
 * Capture the entire scrollback buffer (with ANSI escapes preserved).
 * Used on reattach to replay history into xterm.
 */
export async function capturePaneFullScrollback(name: string): Promise<string> {
  try {
    return await execTmux(['capture-pane', '-t', name, '-p', '-S', '-'], {
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
export async function getSessionInfo(name: string): Promise<{ activity: number; attached: number } | null> {
  try {
    const output = (await execTmux([
      'display-message',
      '-t', name,
      '-p',
      '#{session_activity} #{session_attached}',
    ])).trim();
    const [actStr, attStr] = output.split(' ');
    return { activity: parseInt(actStr, 10) || 0, attached: parseInt(attStr, 10) || 0 };
  } catch {
    return null;
  }
}

/**
 * Get the PID of the root process running in a tmux session's pane.
 */
export async function getPanePid(name: string): Promise<number | null> {
  try {
    const output = (await execTmux([
      'display-message',
      '-t', name,
      '-p',
      '#{pane_pid}',
    ])).trim();
    const pid = parseInt(output, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * List all smith-* tmux sessions with metadata.
 */
export async function listSmithSessions(): Promise<Array<{ name: string; activity: number; attached: number }>> {
  try {
    const output = (await execTmux([
      'list-sessions',
      '-F',
      '#{session_name} #{session_activity} #{session_attached}',
    ])).trim();
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

export function shellTmuxSessionName(sessionId: string): string {
  return `smith-shell-${sessionId.slice(0, 12)}`;
}

export async function createShellTmuxSession(sessionId: string, workingDir: string): Promise<string> {
  const name = shellTmuxSessionName(sessionId);

  if (await hasTmuxSession(name)) {
    console.log(`[tmux] Shell session ${name} already exists, reusing`);
    await configureTmuxSession(name);
    return name;
  }

  const shell = process.env.SHELL || '/bin/bash';
  console.log(`[tmux] Creating shell session ${name} with ${shell}`);

  await new Promise<void>((resolve, reject) => {
    execFile(
      'tmux',
      [
        'new-session', '-d',
        '-s', name,
        '-x', '120',
        '-y', '40',
        '-c', workingDir,
        '--',
        shell, '-l',
      ],
      {
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      },
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });

  await configureTmuxSession(name);
  console.log(`[tmux] Shell session ${name} created`);
  return name;
}

/**
 * Check if tmux is installed. Throws a descriptive error if not.
 */
export async function requireTmux(): Promise<void> {
  try {
    await execTmuxQuiet(['-V']);
  } catch {
    throw new Error(
      'tmux is not installed. DAD requires tmux for session persistence. ' +
      'Install it with: sudo apt-get install tmux'
    );
  }
}
