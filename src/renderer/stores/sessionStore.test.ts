import { describe, it, expect } from 'vitest';
import { pickNextActiveSessionId } from './sessionStore';
import { Session } from '../../main/types';

/** Minimal session stub — only id/archived matter for successor selection. */
function session(id: string, archived = false): Session {
  return { id, name: id, workingDir: '/tmp', state: 'idle', archived } as Session;
}

describe('pickNextActiveSessionId', () => {
  it('returns null when the archived session was the only one', () => {
    expect(pickNextActiveSessionId([session('a')], 'a')).toBeNull();
  });

  it('hands over to the session below', () => {
    const list = [session('a'), session('b'), session('c')];
    expect(pickNextActiveSessionId(list, 'b')).toBe('c');
  });

  it('hands over to the session below when archiving the first one', () => {
    const list = [session('a'), session('b'), session('c')];
    expect(pickNextActiveSessionId(list, 'a')).toBe('b');
  });

  it('falls back to the session above when archiving the last one', () => {
    const list = [session('a'), session('b'), session('c')];
    expect(pickNextActiveSessionId(list, 'c')).toBe('b');
  });

  it('skips already-archived sessions when picking the successor', () => {
    const list = [session('a'), session('b'), session('c', true), session('d')];
    expect(pickNextActiveSessionId(list, 'b')).toBe('d');
  });

  it('never returns the archived session itself', () => {
    const list = [session('a', true), session('b')];
    expect(pickNextActiveSessionId(list, 'b')).toBeNull();
  });
});
