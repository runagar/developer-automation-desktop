import { afterEach, describe, expect, it, vi } from 'vitest';
import { PtySession } from './pty';
import * as pty from 'node-pty';

vi.mock('./tmux', () => ({
  requireTmux: vi.fn().mockResolvedValue(undefined),
  hasTmuxSession: vi.fn().mockResolvedValue(true),
  tmuxSessionName: (id: string) => `smith-${id}`,
}));
vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({ onData: vi.fn(), onExit: vi.fn(), resize: vi.fn(), kill: vi.fn() })),
}));

afterEach(() => { vi.clearAllMocks(); });

describe('PTY attachment sizing', () => {
  it('opens the tmux client at the latest fitted size when the window was resized during bootstrap', async () => {
    // Given
    const session = new PtySession('original');
    session.resize(144, 48);
    // When
    await session.spawn('/work', 96, 28);
    // Then
    expect(pty.spawn).toHaveBeenCalledWith(
      'tmux', ['attach-session', '-t', 'smith-original'],
      expect.objectContaining({ cwd: '/work', cols: 144, rows: 48 }),
    );
  });
});
