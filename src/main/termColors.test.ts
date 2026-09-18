import { describe, it, expect } from 'vitest';
import { answerColorQueries, toOscColor } from './termColors';

const COLORS = { bg: '#000000', fg: '#00ff00' };

const BG_QUERY = '\x1b]11;?\x07';
const FG_QUERY = '\x1b]10;?\x07';

describe('toOscColor', () => {
  it('expands #rrggbb to the 16-bit rgb: form terminals reply with', () => {
    expect(toOscColor('#000000')).toBe('rgb:0000/0000/0000');
    expect(toOscColor('#00ff00')).toBe('rgb:0000/ffff/0000');
    expect(toOscColor('#ff9f1c')).toBe('rgb:ffff/9f9f/1c1c');
  });

  it('normalises uppercase hex', () => {
    expect(toOscColor('#FF9F1C')).toBe('rgb:ffff/9f9f/1c1c');
  });
});

describe('answerColorQueries', () => {
  it('answers a background query with the background colour', () => {
    const { reply, answered } = answerColorQueries(BG_QUERY, COLORS);
    expect(reply).toBe('\x1b]11;rgb:0000/0000/0000\x07');
    expect(answered).toEqual(['bg']);
  });

  it('answers a foreground query with the foreground colour', () => {
    const { reply, answered } = answerColorQueries(FG_QUERY, COLORS);
    expect(reply).toBe('\x1b]10;rgb:0000/ffff/0000\x07');
    expect(answered).toEqual(['fg']);
  });

  it('answers both queries when copilot sends them back to back', () => {
    const { answered } = answerColorQueries(BG_QUERY + FG_QUERY, COLORS);
    expect(answered).toEqual(['bg', 'fg']);
  });

  it('accepts the ST terminator as well as BEL', () => {
    const { answered } = answerColorQueries('\x1b]11;?\x1b\\', COLORS);
    expect(answered).toEqual(['bg']);
  });

  it('ignores surrounding pane output', () => {
    const { answered } = answerColorQueries(`noise${BG_QUERY}more noise`, COLORS);
    expect(answered).toEqual(['bg']);
  });

  // copilot also emits OSC 11 to *set* the background. Answering a set would be
  // replying to our own echo, and could loop.
  it('does not answer a colour-setting sequence', () => {
    const { reply, answered } = answerColorQueries('\x1b]11;#123456\x07', COLORS);
    expect(reply).toBe('');
    expect(answered).toEqual([]);
  });

  it('ignores the OSC 4 palette queries tmux never forwards', () => {
    const { answered } = answerColorQueries('\x1b]4;3;?\x07', COLORS);
    expect(answered).toEqual([]);
  });

  it('keeps a query split across two PTY chunks', () => {
    const first = answerColorQueries('\x1b]11', COLORS);
    expect(first.answered).toEqual([]);

    const second = answerColorQueries(first.rest + ';?\x07', COLORS);
    expect(second.answered).toEqual(['bg']);
  });

  it('bounds the retained buffer so unanswered output cannot grow forever', () => {
    const { rest } = answerColorQueries('x'.repeat(10_000), COLORS);
    expect(rest.length).toBeLessThanOrEqual(256);
  });

  it('consumes answered queries so they are not answered twice', () => {
    const { rest } = answerColorQueries(BG_QUERY, COLORS);
    expect(answerColorQueries(rest, COLORS).answered).toEqual([]);
  });
});
