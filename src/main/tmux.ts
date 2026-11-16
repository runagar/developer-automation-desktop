import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import { createServer } from 'net';
import { homedir } from 'os';
import { readFile, readdir } from 'fs/promises';
import { basename } from 'path';
import { spawnColorResponder } from './termColors';
import { sweepStaleCopilotLocks } from './copilotLocks';
import type { SessionAgent, SessionStartupPhase } from './types';
import {
  OpenCodeConnection, OPENCODE_INSTALL_COMMAND, createOpenCodeConversation,
  getOpenCodeConversation, getOpenCodeMigrationStatus, getOpenCodeServerVersion,
  isSupportedOpenCodeVersion, validateOpenCodeSessionId,
} from './opencode';

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

interface TmuxAgentOptions {
  agent: SessionAgent;
  agentSessionId: string | null;
  name: string;
  onConversationCreated: (id: string) => void;
  onPhase?: (phase: SessionStartupPhase) => void;
  replaceLegacy?: boolean;
}

const OPENCODE_SERVER = 'dad-opencode-server';
const OPENCODE_AGENT = 'dad-opencode-agent';
const OPENCODE_RUNTIME_MARKER = 'DAD_OPENCODE_RUNTIME';
const OPENCODE_RUNTIME_VERSION = '2';
const OPENCODE_CLIENT_CONFIG = JSON.stringify({ tabs: { mode: 'off' } });
const OPENCODE_MIGRATION_TIMEOUT_MS = 10 * 60 * 1000;
const DIRENV_COMMAND = 'if command -v direnv >/dev/null 2>&1; then eval "$(direnv export zsh 2>/dev/null || direnv export bash 2>/dev/null)"; fi';
const OPENCODE_PATH_COMMAND = 'if ! command -v opencode >/dev/null 2>&1; then export PATH="$PATH:$HOME/.opencode/bin:$HOME/.local/bin"; fi';
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function createTmuxSession(
  sessionId: string,
  workingDir: string,
  options: TmuxAgentOptions,
): Promise<string> {
  await requireTmux();
  const name = tmuxSessionName(sessionId);
  if (options.agent === 'opencode') return createOpenCodeTmuxSession(name, workingDir, options);

  if (await hasTmuxSession(name)) {
    console.log(`[tmux] Session ${name} already exists, reusing`);
    await configureTmuxSession(name);
    return name;
  }

  console.log(`[tmux] Creating session ${name} for copilot --session-id ${sessionId}`);

  // A previous run's copilot was killed without releasing its in-use lock (app
  // quit leaves tmux running, a reboot kills it outright). Drop the locks that
  // cannot belong to a live client, or copilot greets the restored session with
  // its "in use by another CLI or application" prompt.
  await sweepStaleCopilotLocks(sessionId);

  // Wrap copilot in the user's login-interactive shell so that PATH additions
  // from shell config files (.zshrc, .bashrc, etc.) are available — e.g. SDKMAN
  // (Java), pyenv, rbenv. We also explicitly trigger direnv (if installed) so
  // that per-project .envrc settings (e.g. Java/Maven version) are applied.
  // `exec` replaces the shell with copilot so that when copilot exits the tmux
  // window closes (preserving died-detection behaviour).
  const shell = process.env.SHELL || '/bin/bash';
  const copilotCmd = [
    DIRENV_COMMAND,
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

  // copilot asks the terminal for its colours within ~300 ms of starting, and
  // nothing is attached yet to answer. Do it for it, or the session renders in
  // the 16-colour fallback theme for the rest of its life. Deliberately not
  // awaited — session creation must not wait on copilot booting.
  spawnColorResponder(name);

  console.log(`[tmux] Session ${name} created`);
  return name;
}

interface TmuxPane {
  window: string;
  pid: number;
  dead: boolean;
  command: string;
}

async function getTmuxPanes(name: string): Promise<TmuxPane[]> {
  const output = await execTmux([
    'list-panes', '-s', '-t', name, '-F',
    '#{window_name}\t#{pane_pid}\t#{pane_dead}\t#{pane_current_command}',
  ]);
  return output.trim().split('\n').map((line) => {
    const [window, pid, dead, command] = line.split('\t');
    return { window, pid: Number(pid), dead: dead === '1', command };
  });
}

async function getTmuxEnvironment(name: string): Promise<Map<string, string>> {
  const output = await execTmux(['show-environment', '-t', name]);
  return new Map(output.split('\n').flatMap((line): [string, string][] => {
    const separator = line.indexOf('=');
    return separator > 0 ? [[line.slice(0, separator), line.slice(separator + 1)]] : [];
  }));
}

export async function getOpenCodeConnection(name: string, workingDir: string): Promise<OpenCodeConnection> {
  const env = await getTmuxEnvironment(name);
  if (env.get(OPENCODE_RUNTIME_MARKER) !== OPENCODE_RUNTIME_VERSION) {
    throw new Error('OpenCode runtime predates OpenCode 2 support');
  }
  const port = Number(env.get('DAD_OPENCODE_PORT'));
  const password = env.get('OPENCODE_PASSWORD');
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !password) {
    throw new Error('OpenCode runtime metadata is missing or invalid');
  }
  return { port, password, workingDir };
}

export async function isLegacyOpenCodeRuntime(name: string): Promise<boolean> {
  try {
    return (await getTmuxEnvironment(name)).get(OPENCODE_RUNTIME_MARKER) !== OPENCODE_RUNTIME_VERSION;
  } catch {
    // A runtime that vanished before its environment could be read is not a legacy runtime.
    return false;
  }
}

export function readOpenCodeCliVersion(): Promise<string | null> {
  const shell = process.env.SHELL || '/bin/bash';
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-lic', `${OPENCODE_PATH_COMMAND}; opencode --version`],
      { cwd: homedir(), timeout: 10000, encoding: 'utf-8' },
      (err, stdout) => {
        const versions = err ? [] : [...String(stdout).matchAll(/v?(\d+\.\d+\.\d+\S*)/g)];
        resolve(versions.length > 0 ? versions[versions.length - 1][1] : null);
      },
    );
  });
}

export async function isAgentTmuxAlive(name: string, agent: SessionAgent): Promise<boolean> {
  if (!await hasTmuxSession(name)) return false;
  if (agent === 'copilot') return true;
  const panes = await getTmuxPanes(name);
  return [OPENCODE_SERVER, OPENCODE_AGENT].every(
    (window) => panes.some((pane) => pane.window === window && !pane.dead),
  );
}

async function allocateOpenCodePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate an OpenCode loopback port'));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function runOpenCodeTmux(args: string[]): Promise<void> {
  try {
    await execTmuxQuiet(args);
  } catch {
    throw new Error(`OpenCode tmux ${args[0]} failed`);
  }
}

async function waitForOpenCodeServer(name: string, connection: OpenCodeConnection): Promise<void> {
  const deadline = Date.now() + 30000;
  let failure = 'OpenCode server did not become ready';
  while (Date.now() < deadline) {
    const panes = await getTmuxPanes(name);
    if (!panes.some((pane) => pane.window === OPENCODE_SERVER && !pane.dead)) {
      throw new Error('OpenCode server exited. Check that opencode is installed and available in your login shell.');
    }
    const version = await getOpenCodeServerVersion(connection).catch((error: unknown) => {
      failure = error instanceof Error ? error.message : 'OpenCode health check failed';
      return null;
    });
    if (version !== null) {
      if (isSupportedOpenCodeVersion(version)) return;
      throw new Error(`DAD requires OpenCode 2, but opencode is ${version}. Install OpenCode 2 with: ${OPENCODE_INSTALL_COMMAND}`);
    }
    await pause(200);
  }
  throw new Error(`OpenCode server startup timed out: ${failure}`);
}

async function waitForOpenCodeMigration(
  connection: OpenCodeConnection,
  onPhase?: (phase: SessionStartupPhase) => void,
): Promise<void> {
  const deadline = Date.now() + OPENCODE_MIGRATION_TIMEOUT_MS;
  let reported = false;
  while (Date.now() < deadline) {
    const migration = await getOpenCodeMigrationStatus(connection).catch((error: unknown) => {
      console.warn('[tmux] Could not read OpenCode history migration status, retrying', error);
      return { status: 'pending' } as const;
    });
    if (migration.status === 'done') return;
    if (migration.status === 'failed') {
      throw new Error(`OpenCode could not migrate its OpenCode 1 history: ${migration.error}`);
    }
    if (!reported) {
      onPhase?.('migrate-history');
      reported = true;
    }
    await pause(500);
  }
  console.warn('[tmux] OpenCode history migration has not finished; continuing startup');
}

async function waitForOpenCodeAgent(name: string, shell: string): Promise<void> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const pane = (await getTmuxPanes(name)).find((candidate) => candidate.window === OPENCODE_AGENT);
    if (!pane || pane.dead) throw new Error('OpenCode terminal exited during startup');
    if (pane.command && pane.command !== basename(shell)) {
      await pause(500);
      if (await isAgentTmuxAlive(name, 'opencode')) return;
      throw new Error('OpenCode terminal exited during startup');
    }
    await pause(200);
  }
  throw new Error('OpenCode terminal startup timed out');
}

async function createOpenCodeTmuxSession(
  name: string,
  workingDir: string,
  options: TmuxAgentOptions,
): Promise<string> {
  const shell = process.env.SHELL || '/bin/bash';
  if (await hasTmuxSession(name) && await isLegacyOpenCodeRuntime(name)) {
    if (!options.replaceLegacy) {
      throw new Error('This session is still running OpenCode 1. Revive it to restart it on OpenCode 2.');
    }
    console.log(`[tmux] Replacing OpenCode 1 runtime ${name}`);
    await killTmuxSession(name);
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      options.onPhase?.('server');
      if (await hasTmuxSession(name)) {
        const server = (await getTmuxPanes(name)).find((pane) => pane.window === OPENCODE_SERVER);
        if (!server || server.dead) await killTmuxSession(name);
      }
      if (!await hasTmuxSession(name)) {
        const port = await allocateOpenCodePort();
        const password = randomBytes(32).toString('hex');
        await runOpenCodeTmux([
          'new-session', '-d', '-s', name, '-n', OPENCODE_SERVER,
          '-x', '120', '-y', '40', '-c', workingDir,
          '-e', `DAD_OPENCODE_PORT=${port}`,
          '-e', `${OPENCODE_RUNTIME_MARKER}=${OPENCODE_RUNTIME_VERSION}`,
          '-e', `OPENCODE_PASSWORD=${password}`,
          '-e', `OPENCODE_SERVER_PASSWORD=${password}`,
          '-e', 'TERM=xterm-256color', '-e', 'COLORTERM=truecolor',
          '--', shell, '-lic',
          `${DIRENV_COMMAND}; ${OPENCODE_PATH_COMMAND}; exec opencode serve --hostname 127.0.0.1 --port ${port}`,
          ';', 'set-window-option', '-t', `${name}:${OPENCODE_SERVER}`, 'remain-on-exit', 'on',
        ]);
      }
      const connection = await getOpenCodeConnection(name, workingDir);
      await waitForOpenCodeServer(name, connection);
      await waitForOpenCodeMigration(connection, options.onPhase);
      const environment = await getTmuxEnvironment(name);
      const recordedId = environment.get('DAD_OPENCODE_SESSION_ID');
      if (recordedId && options.agentSessionId && recordedId !== options.agentSessionId) {
        throw new Error('OpenCode runtime is bound to a different conversation');
      }
      const existingId = options.agentSessionId ?? recordedId;
      options.onPhase?.(existingId === undefined ? 'create-conversation' : 'load-conversation');
      const id = validateOpenCodeSessionId(
        existingId ?? await createOpenCodeConversation(connection, options.name),
      );
      await getOpenCodeConversation(connection, id);
      await runOpenCodeTmux(['set-environment', '-t', name, 'DAD_OPENCODE_SESSION_ID', id]);
      options.onConversationCreated(id);
      options.onPhase?.('tui');
      const agent = (await getTmuxPanes(name)).find((pane) => pane.window === OPENCODE_AGENT);
      if (agent?.dead) await execTmuxQuiet(['kill-window', '-t', `${name}:${OPENCODE_AGENT}`]);
      if (!agent || agent.dead) {
        await runOpenCodeTmux([
          'new-window', '-d', '-t', name, '-n', OPENCODE_AGENT, '-c', workingDir,
          '-e', `OPENCODE_CLI_CONFIG_CONTENT=${OPENCODE_CLIENT_CONFIG}`,
          '--', shell, '-lic',
          `${DIRENV_COMMAND}; ${OPENCODE_PATH_COMMAND}; exec opencode --server http://127.0.0.1:${connection.port} --session ${id} .`,
          ';', 'set-window-option', '-t', `${name}:${OPENCODE_AGENT}`, 'remain-on-exit', 'on',
        ]);
      }
      await execTmuxQuiet(['select-window', '-t', `${name}:${OPENCODE_AGENT}`]);
      await configureTmuxSession(name);
      if (!agent || agent.dead) await waitForOpenCodeAgent(name, shell);
      console.log(`[tmux] OpenCode session ${name} ready`);
      return name;
    } catch (error) {
      const output = await capturePane(`${name}:${OPENCODE_SERVER}`);
      const portConflict = /EADDRINUSE|address already in use/i.test(output);
      await killTmuxSession(name);
      if (portConflict && attempt < 2) {
        console.warn(`[tmux] Retrying OpenCode session ${name} on another port`);
        continue;
      }
      throw error;
    }
  }
  throw new Error('OpenCode could not acquire a loopback port');
}

async function readProcessGroup(pid: number): Promise<{ group: number; running: boolean } | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { group: Number(fields[2]), running: fields[0] !== 'Z' && fields[0] !== 'X' };
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'ESRCH' || error.code === 'ENOENT')) return null;
    throw error;
  }
}

async function isProcessGroupRunning(pid: number): Promise<boolean> {
  try {
    process.kill(-pid, 0);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
  if (process.platform !== 'linux') return true;
  const root = await readProcessGroup(pid);
  if (root?.group === pid && root.running) return true;
  const processes = (await readdir('/proc')).filter((entry) => /^\d+$/.test(entry));
  const groups = await Promise.all(processes.map((entry) => readProcessGroup(Number(entry))));
  return groups.some((group) => group?.group === pid && group.running);
}

async function terminateOpenCodeProcesses(panes: TmuxPane[]): Promise<void> {
  const pids = [...new Set(panes
    .filter((pane) => [OPENCODE_SERVER, OPENCODE_AGENT].includes(pane.window))
    .map((pane) => pane.pid))];
  for (const pid of pids) {
    if (!Number.isInteger(pid) || pid <= 1) throw new Error('Invalid OpenCode process group');
    if (!await isProcessGroupRunning(pid)) continue;
    try {
      process.kill(-pid, 'SIGCONT');
      process.kill(-pid, 'SIGTERM');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
    }
  }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && (await Promise.all(pids.map(isProcessGroupRunning))).some(Boolean)) {
    await pause(100);
  }
  for (const pid of pids) {
    if (!await isProcessGroupRunning(pid)) continue;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
    }
  }
  const killDeadline = Date.now() + 1000;
  while (Date.now() < killDeadline && (await Promise.all(pids.map(isProcessGroupRunning))).some(Boolean)) {
    await pause(50);
  }
  if ((await Promise.all(pids.map(isProcessGroupRunning))).some(Boolean)) {
    throw new Error('OpenCode processes did not exit');
  }
}

export async function killTmuxSession(name: string): Promise<void> {
  if (!await hasTmuxSession(name)) return;
  console.log(`[tmux] Killing session ${name}`);
  const panes = await getTmuxPanes(name);
  await terminateOpenCodeProcesses(panes);
  try {
    await execTmuxQuiet(['kill-session', '-t', name]);
  } catch (error) {
    if (await hasTmuxSession(name)) throw error;
  }
}

/**
 * Keep the viewport where it is when a copy ends above the live bottom.
 *
 * `mouse on` hands selection to tmux, whose default `MouseDragEnd1Pane` is
 * `copy-pipe-and-cancel`: leaving copy-mode snaps the pane back to the bottom,
 * losing the user's place the moment they copy something they scrolled up to
 * read. Dropping `-and-cancel` outright is worse, though — selecting at the
 * bottom would then strand the pane in copy-mode, where keystrokes never reach
 * the shell. `scroll_position` tells the two apart: 0 means the user never
 * scrolled, so cancel as before.
 *
 * Key tables are **server-global** — there is no per-session form — so this
 * also applies to tmux sessions outside DAD on the same server. Both tables
 * are bound because which one is live depends on `mode-keys`.
 */
const DRAG_END_BINDING = [
  'if-shell', '-F', '#{==:#{scroll_position},0}',
  'send-keys -X copy-pipe-and-cancel',
  'send-keys -X copy-pipe',
];

async function configureTmuxSession(name: string): Promise<void> {
  const options: Array<[string, string]> = [
    ['mouse', 'on'],
    ['status', 'off'],
    ['history-limit', '50000'],
    ['allow-passthrough', 'on'],
    ['set-clipboard', 'on'],
  ];

  await Promise.all([
    ...options.map(async ([key, value]) => {
      try {
        await execTmuxQuiet(['set-option', '-t', name, key, value]);
      } catch {
        // non-fatal
      }
    }),
    ...['copy-mode', 'copy-mode-vi'].map(async (table) => {
      try {
        await execTmuxQuiet(['bind-key', '-T', table, 'MouseDragEnd1Pane', ...DRAG_END_BINDING]);
      } catch {
        // non-fatal
      }
    }),
  ]);
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
