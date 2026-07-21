/**
 * Intercept OSC 52 clipboard sequences from terminal data.
 *
 * OSC 52 format: \x1b]52;<target>;<base64-payload><ST>
 * where ST is \x07 (BEL) or \x1b\\ (ST).
 *
 * When detected, decodes the base64 payload and writes to system clipboard.
 * Returns the data string with OSC 52 sequences stripped (so xterm doesn't
 * attempt its own clipboard handling which may fail due to permissions).
 */

const OSC52_RE = /\x1b\]52;[^;]*;([A-Za-z0-9+/=]*)\x07|\x1b\]52;[^;]*;([A-Za-z0-9+/=]*)\x1b\\/g;

export function handleOsc52(data: string): string {
  let match: RegExpExecArray | null;
  let hasMatch = false;

  OSC52_RE.lastIndex = 0;
  while ((match = OSC52_RE.exec(data)) !== null) {
    hasMatch = true;
    const b64 = match[1] ?? match[2];
    if (b64) {
      try {
        const text = atob(b64);
        window.dad.clipboardWrite(text);
      } catch {
        // invalid base64 — ignore
      }
    }
  }

  if (hasMatch) {
    return data.replace(OSC52_RE, '');
  }
  return data;
}
