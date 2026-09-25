import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sweepStaleCopilotLocks, copilotSessionStateDir } from './copilotLocks';

let tmpHome: string;
let originalHome: string | undefined;

const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function stateDir(sessionId = SESSION_ID): string {
  const dir = copilotSessionStateDir(sessionId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeLock(pid: number, opts?: { mtime?: Date; sessionId?: string }): string {
  const file = path.join(stateDir(opts?.sessionId), `inuse.${pid}.lock`);
  fs.writeFileSync(file, '');
  if (opts?.mtime) fs.utimesSync(file, opts.mtime, opts.mtime);
  return file;
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dad-copilot-home-'));
  originalHome = process.env.COPILOT_HOME;
  process.env.COPILOT_HOME = tmpHome;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.COPILOT_HOME;
  else process.env.COPILOT_HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('sweepStaleCopilotLocks', () => {
  it('returns 0 when the session has no state directory', async () => {
    expect(await sweepStaleCopilotLocks('no-such-session')).toBe(0);
  });

  it('removes locks whose owning process is gone', async () => {
    const file = writeLock(0x7ffffff0);

    expect(await sweepStaleCopilotLocks(SESSION_ID)).toBe(1);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('keeps locks written by a live process', async () => {
    const file = writeLock(process.pid);

    expect(await sweepStaleCopilotLocks(SESSION_ID)).toBe(0);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('removes locks predating the start of the process now holding the pid', async () => {
    // A lock is always written by an already-running process, so a lock older
    // than its pid's start time means the pid was reused — e.g. after a reboot.
    const file = writeLock(process.pid, { mtime: new Date(Date.now() - 24 * 3600 * 1000) });

    expect(await sweepStaleCopilotLocks(SESSION_ID)).toBe(1);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('ignores files that are not in-use locks', async () => {
    const dir = stateDir();
    const other = path.join(dir, 'events.jsonl');
    fs.writeFileSync(other, 'x');

    expect(await sweepStaleCopilotLocks(SESSION_ID)).toBe(0);
    expect(fs.existsSync(other)).toBe(true);
  });

  it('only touches the requested session', async () => {
    const mine = writeLock(0x7ffffff0);
    const theirs = writeLock(0x7ffffff0, { sessionId: 'other-session' });

    expect(await sweepStaleCopilotLocks(SESSION_ID)).toBe(1);
    expect(fs.existsSync(mine)).toBe(false);
    expect(fs.existsSync(theirs)).toBe(true);
  });
});
