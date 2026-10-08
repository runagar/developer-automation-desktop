import { describe, it, expect, vi } from 'vitest';
import { createOsc52Handler } from './osc52';

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
const seq = (s: string, term = '\x07'): string => `\x1b]52;c;${b64(s)}${term}`;

function handler(): { feed: (d: string) => string; copied: string[] } {
  const copied: string[] = [];
  return { feed: createOsc52Handler((t) => copied.push(t)), copied };
}

describe('createOsc52Handler', () => {
  it('copies a sequence and strips it from the output', () => {
    const { feed, copied } = handler();
    expect(feed(`before${seq('hello')}after`)).toBe('beforeafter');
    expect(copied).toEqual(['hello']);
  });

  it('accepts the ST terminator as well as BEL', () => {
    const { feed, copied } = handler();
    expect(feed(seq('hi', '\x1b\\'))).toBe('');
    expect(copied).toEqual(['hi']);
  });

  it('decodes the payload as UTF-8', () => {
    // atob alone would mangle these into one byte per code unit.
    const { feed, copied } = handler();
    feed(seq('æblegrød — ✓'));
    expect(copied).toEqual(['æblegrød — ✓']);
  });

  it('reassembles a sequence split across chunks', () => {
    // tmux emits a whole copy-mode selection as one OSC 52, so a large copy
    // exceeds a single PTY read. Matching per chunk would miss it entirely.
    const { feed, copied } = handler();
    const whole = seq('x'.repeat(200));
    const cut = Math.floor(whole.length / 2);

    expect(feed(`head${whole.slice(0, cut)}`)).toBe('head');
    expect(copied).toEqual([]);
    expect(feed(`${whole.slice(cut)}tail`)).toBe('tail');
    expect(copied).toEqual(['x'.repeat(200)]);
  });

  it('reassembles a sequence split across many chunks', () => {
    const { feed, copied } = handler();
    const payload = 'y'.repeat(100_000);
    const whole = seq(payload);
    let out = '';
    for (let i = 0; i < whole.length; i += 4096) out += feed(whole.slice(i, i + 4096));

    expect(out).toBe('');
    expect(copied).toEqual([payload]);
  });

  it('holds back an introducer that straddles the boundary', () => {
    const { feed, copied } = handler();
    const whole = seq('split-intro');

    // Cut inside "\x1b]52;" itself.
    expect(feed(whole.slice(0, 2))).toBe('');
    expect(feed(whole.slice(2))).toBe('');
    expect(copied).toEqual(['split-intro']);
  });

  it('passes through a terminated sequence it cannot parse', () => {
    // A payload outside the base64 alphabet never matches; holding it would
    // stall every later byte of output behind it.
    const { feed, copied } = handler();
    expect(feed('a\x1b]52;c;?\x07b')).toBe('a\x1b]52;c;?\x07b');
    expect(copied).toEqual([]);
  });

  it('keeps each terminal independent', () => {
    const a = handler();
    const b = handler();
    const whole = seq('from-a');

    a.feed(whole.slice(0, 10));
    expect(b.feed('plain output')).toBe('plain output');
    a.feed(whole.slice(10));

    expect(a.copied).toEqual(['from-a']);
    expect(b.copied).toEqual([]);
  });

  it('ignores a payload that is not valid base64', () => {
    const { feed, copied } = handler();
    const spy = vi.spyOn(globalThis, 'atob').mockImplementation(() => { throw new Error('bad'); });
    expect(feed(seq('whatever'))).toBe('');
    expect(copied).toEqual([]);
    spy.mockRestore();
  });
});
