/**
 * Intercept OSC 52 clipboard sequences from terminal data.
 *
 * OSC 52 format: \x1b]52;<target>;<base64-payload><ST>
 * where ST is \x07 (BEL) or \x1b\\ (ST).
 *
 * When detected, the base64 payload is decoded and handed to `write`. The
 * sequence is stripped from the returned string so xterm does not attempt its
 * own clipboard handling, which may fail due to permissions.
 *
 * **Stateful across chunks.** tmux emits a whole copy-mode selection as a
 * single OSC 52, so copying a large block produces a sequence far longer than
 * one PTY read — around 48 KB of selected text is enough to exceed it. A
 * per-chunk matcher never sees such a sequence whole: the clipboard silently
 * keeps its previous contents and the fragments are passed on to the terminal.
 * An unterminated trailing sequence is therefore held back and completed by
 * the next chunk.
 */

const OSC52_RE = /\x1b\]52;[^;]*;([A-Za-z0-9+/=]*)\x07|\x1b\]52;[^;]*;([A-Za-z0-9+/=]*)\x1b\\/g;

const OSC52_INTRO = '\x1b]52;';

/**
 * Ceiling on a held-back sequence, after which it is released as ordinary
 * output. Only a malformed stream reaches this; without it a stray introducer
 * would stall the terminal indefinitely.
 */
const MAX_PENDING = 8 * 1024 * 1024;

/** Decode base64 payload as UTF-8 (atob alone corrupts non-ASCII). */
function decodeBase64Utf8(b64: string): string {
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Where an unfinished OSC 52 starts, or -1.
 *
 * Called only after every complete sequence has been stripped, so a surviving
 * introducer belongs to one still arriving — unless it is already terminated,
 * which means it failed to match and is malformed.
 */
function incompleteTailIndex(s: string): number {
  const start = s.lastIndexOf(OSC52_INTRO);
  if (start !== -1) {
    const rest = s.slice(start);
    const terminated = rest.indexOf('\x07') !== -1 || rest.indexOf('\x1b\\', 1) !== -1;
    return terminated ? -1 : start;
  }

  // The introducer itself can straddle a chunk boundary.
  for (let n = OSC52_INTRO.length - 1; n > 0; n--) {
    if (s.endsWith(OSC52_INTRO.slice(0, n))) return s.length - n;
  }
  return -1;
}

/**
 * One handler per terminal — the held-back tail is per-stream state and must
 * not be shared between panels.
 */
export function createOsc52Handler(write: (text: string) => void): (data: string) => string {
  let pending = '';

  return function handleOsc52(data: string): string {
    const text = (pending + data).replace(OSC52_RE, (_match, bel?: string, st?: string) => {
      const b64 = bel ?? st;
      if (b64) {
        try {
          write(decodeBase64Utf8(b64));
        } catch {
          // Invalid base64 — drop it rather than clobbering the clipboard.
        }
      }
      return '';
    });
    pending = '';

    const idx = incompleteTailIndex(text);
    if (idx !== -1 && text.length - idx <= MAX_PENDING) {
      pending = text.slice(idx);
      return text.slice(0, idx);
    }
    return text;
  };
}
