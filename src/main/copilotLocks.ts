import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

/**
 * Copilot CLI marks a session as in use by writing `inuse.<pid>.lock` into its
 * session-state directory, and releases it on a clean shutdown. On resume it
 * sweeps those files, keeps the ones whose pid is still running, and — if any
 * survive — prompts "This session was last active … and appears to be in use
 * by another CLI or application".
 *
 * DAD never shuts copilot down cleanly (tmux sessions outlive the app by
 * design, and a host reboot kills them outright), so locks are routinely left
 * behind. After a reboot the pid space restarts from the low numbers, so a
 * leftover pid is very likely to be held by an unrelated live process — copilot
 * then mistakes the lock for a live client and prompts on a session nobody is
 * attached to.
 *
 * A lock is provably stale when its pid is gone, or when the process holding
 * that pid started *after* the lock was written — a lock is always written by
 * an already-running process, so that ordering only happens on pid reuse.
 */

const LOCK_RE = /^inuse\.(\d+)\.lock$/;

// Filesystem timestamp granularity slack. A legitimate lock is written after
// its owner starts, so only pid reuse puts the process start ahead of it.
const START_SLACK_MS = 5_000;

function copilotHome(): string {
  return process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot');
}

export function copilotSessionStateDir(sessionId: string): string {
  return path.join(copilotHome(), 'session-state', sessionId);
}

/** Process start time in epoch ms, or null when the pid is not running. */
async function processStartTime(pid: number): Promise<number | null> {
  try {
    // The /proc/<pid> directory carries the process start time.
    const stat = await fs.stat(`/proc/${pid}`);
    return stat.mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Remove provably stale copilot in-use locks for a session. Call immediately
 * before launching `copilot --session-id <id>`.
 *
 * Returns the number of lock files removed.
 */
export async function sweepStaleCopilotLocks(sessionId: string): Promise<number> {
  // Staleness is derived from /proc; without it every lock would look dead.
  if (process.platform !== 'linux') return 0;

  const dir = copilotSessionStateDir(sessionId);

  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    // No session state yet (new session) or an unreadable directory.
    return 0;
  }

  let removed = 0;
  for (const entry of entries) {
    const match = LOCK_RE.exec(entry);
    if (!match) continue;

    const pid = parseInt(match[1], 10);
    const file = path.join(dir, entry);

    let lockMtimeMs: number;
    try {
      lockMtimeMs = (await fs.stat(file)).mtimeMs;
    } catch {
      continue;
    }

    const startedAt = await processStartTime(pid);
    const stale = startedAt === null || startedAt > lockMtimeMs + START_SLACK_MS;
    if (!stale) continue;

    try {
      await fs.unlink(file);
      removed += 1;
      console.log(
        `[copilot-locks] Removed stale in-use lock ${entry} for session ${sessionId} ` +
        `(${startedAt === null ? 'pid gone' : 'pid reused'})`
      );
    } catch {
      // Lost a race with copilot's own sweep, or the file is not ours to
      // remove — either way copilot decides for itself from here.
    }
  }

  return removed;
}
