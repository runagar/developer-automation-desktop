import * as pty from 'node-pty';

/**
 * Copilot CLI >= 1.0.85 asks the terminal what it looks like before choosing a
 * theme: it writes OSC 10 (foreground) and OSC 11 (background) queries and
 * waits ~300 ms for the answers. With both in hand it renders its full 24-bit
 * theme; without them it falls back to a palette built from the 16 named ANSI
 * colours, which our Pip-Boy xterm palette paints amber.
 *
 * DAD creates every tmux session detached (`new-session -d`) and defers PTY
 * attachment to the renderer, so at the moment copilot asks there is usually no
 * client for tmux to forward the query to and nothing answers. Only a session
 * whose panel happened to attach inside that 300 ms window came out right.
 *
 * So DAD answers for itself: a throwaway tmux client is attached for the length
 * of copilot's startup purely to reply to those two queries, then detaches.
 *
 * tmux forwards only OSC 10 and OSC 11 to a client — the per-index OSC 4
 * palette queries copilot also sends are never relayed and cannot be answered.
 * That is fine: copilot treats the palette as optional and succeeds on bg + fg
 * alone (it logs `detected bg=… fg=… ansi=0/16`).
 */

export interface TerminalColors {
  /** Background colour as `#rrggbb` — decides copilot's light/dark theme. */
  bg: string;
  /** Foreground colour as `#rrggbb` — copilot derives one accent from it. */
  fg: string;
}

/** Matches the `phosphor-green` entry in `src/renderer/xterm-theme.ts`. */
const DEFAULT_COLORS: TerminalColors = { bg: '#000000', fg: '#00ff00' };

const HEX_RE = /^#[0-9a-f]{6}$/i;

let current: TerminalColors = { ...DEFAULT_COLORS };

/**
 * Record the colours the renderer's xterm instances are currently using, so the
 * answer DAD gives is the one xterm.js would have given. Invalid input is
 * ignored rather than stored — a malformed colour would make every future
 * session fall back, which is the bug this module exists to prevent.
 */
export function setTerminalColors(colors: TerminalColors): void {
  if (!HEX_RE.test(colors.bg) || !HEX_RE.test(colors.fg)) {
    console.warn('[termColors] Ignoring invalid colours', colors);
    return;
  }
  current = { bg: colors.bg, fg: colors.fg };
}

export function getTerminalColors(): TerminalColors {
  return current;
}

/** `#rrggbb` → the `rgb:rrrr/gggg/bbbb` form terminals reply with. */
export function toOscColor(hex: string): string {
  const part = (i: number): string => hex.slice(i, i + 2).toLowerCase().repeat(2);
  return `rgb:${part(1)}/${part(3)}/${part(5)}`;
}

/**
 * OSC 10/11 colour *queries* only. The trailing `?` is what distinguishes a
 * query from copilot setting a colour — matching a set would make DAD answer
 * its own echo and could loop.
 */
const QUERY_RE = /\x1b\](10|11);\?(?:\x07|\x1b\\|\x9c)/;

/**
 * Consume every complete colour query in `buffer`, returning the replies to
 * send and whatever trailing bytes could not yet be parsed. Split writes are
 * normal on a PTY, so an incomplete query must survive to the next chunk.
 */
export function answerColorQueries(
  buffer: string,
  colors: TerminalColors,
): { reply: string; rest: string; answered: Array<'fg' | 'bg'> } {
  let rest = buffer;
  let reply = '';
  const answered: Array<'fg' | 'bg'> = [];

  for (;;) {
    const match = rest.match(QUERY_RE);
    if (!match || match.index === undefined) break;

    rest = rest.slice(match.index + match[0].length);
    if (match[1] === '11') {
      reply += `\x1b]11;${toOscColor(colors.bg)}\x07`;
      answered.push('bg');
    } else {
      reply += `\x1b]10;${toOscColor(colors.fg)}\x07`;
      answered.push('fg');
    }
  }

  // Keep only enough tail to complete a query that straddles two chunks.
  if (rest.length > 256) rest = rest.slice(-256);

  return { reply, rest, answered };
}

/** How long to keep answering. Must outlast the login shell *and* copilot's boot. */
const RESPONDER_TIMEOUT_MS = 30_000;

/**
 * Attach a throwaway tmux client that answers copilot's colour queries, then
 * detaches. Fire-and-forget: never awaited by session creation, and every
 * failure is swallowed, because a session that starts with the fallback theme
 * is still a working session.
 *
 * It answers **every** query for the whole window rather than detaching after
 * the first background/foreground pair. The interactive login shell that wraps
 * copilot probes the terminal itself, so the first pair is usually the shell's,
 * a second or two before copilot has even started — detaching then leaves
 * copilot's own query unanswered and is indistinguishable from not running at
 * all. There is no way to tell the two apart from here: copilot's distinguishing
 * mark is the 16 OSC 4 palette queries, and tmux never forwards those.
 *
 * Staying attached is safe because tmux's `window-size` is `latest`: a real
 * panel attaching later becomes the latest client and sizes the window, so a
 * lingering responder cannot clamp it.
 */
export function spawnColorResponder(tmuxName: string, cols = 120, rows = 40): void {
  let client: pty.IPty | null;
  try {
    client = pty.spawn('tmux', ['attach-session', '-t', tmuxName], {
      name: 'xterm-256color',
      cols,
      rows,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>,
    });
  } catch (error) {
    console.warn(`[termColors] Could not attach colour responder to ${tmuxName}`, error);
    return;
  }

  const colors = getTerminalColors();
  let buffer = '';
  let total = 0;
  let done = false;

  const finish = (): void => {
    if (done) return;
    done = true;
    clearTimeout(timeout);
    try { client?.kill(); } catch { /* already gone */ }
    client = null;
  };

  const timeout = setTimeout(() => {
    if (total === 0) {
      console.log(`[termColors] No colour query from ${tmuxName} — theme may fall back`);
    } else {
      console.log(`[termColors] Answered ${total} colour queries for ${tmuxName} (bg=${colors.bg}, fg=${colors.fg})`);
    }
    finish();
  }, RESPONDER_TIMEOUT_MS);

  client.onData((data: string) => {
    if (done) return;
    buffer += data;

    const { reply, rest, answered } = answerColorQueries(buffer, colors);
    buffer = rest;
    if (!reply) return;

    try {
      client?.write(reply);
    } catch {
      finish();
      return;
    }
    total += answered.length;
  });

  client.onExit(() => finish());
}
