import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readSessionState, StatePoller } from './statePoller';
import { capturePane, getOpenCodeConnection, isAgentTmuxAlive, listSmithSessions } from './tmux';
import { getOpenCodeState } from './opencode';
import type { PollableSession } from './statePoller';

vi.mock('./tmux', () => ({
  ANSI_RE: /\x1b\[[0-9;]*m/g,
  tmuxSessionName: (id: string) => `smith-${id}`,
  capturePane: vi.fn(),
  getOpenCodeConnection: vi.fn(),
  isAgentTmuxAlive: vi.fn(),
  listSmithSessions: vi.fn(),
}));
vi.mock('./opencode', () => ({ getOpenCodeState: vi.fn() }));

const openCode: PollableSession = {
  id: 'open', agent: 'opencode', agentSessionId: 'ses_original', workingDir: '/work', state: 'running',
};
const copilot: PollableSession = { ...openCode, id: 'copilot', agent: 'copilot', agentSessionId: null };
let poller: StatePoller | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(getOpenCodeConnection).mockResolvedValue({ port: 43210, password: 'secret', workingDir: '/work' });
  vi.mocked(getOpenCodeState).mockResolvedValue('awaiting');
  vi.mocked(capturePane).mockResolvedValue('/ commands');
  vi.mocked(isAgentTmuxAlive).mockResolvedValue(true);
  vi.mocked(listSmithSessions).mockResolvedValue([
    { name: 'smith-open', activity: 0, attached: 0 },
    { name: 'smith-copilot', activity: 0, attached: 0 },
  ]);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  poller?.stop();
  poller = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe('agent-specific polling', () => {
  it('uses the bound API conversation for OpenCode and pane detection for Copilot', async () => {
    // Given
    const connection = await getOpenCodeConnection('smith-open', '/work');
    // When
    const states = await Promise.all([readSessionState(openCode), readSessionState(copilot)]);
    // Then
    expect(states).toEqual(['awaiting', 'idle']);
    expect(getOpenCodeState).toHaveBeenCalledWith(connection, 'ses_original');
    expect(capturePane).toHaveBeenCalledExactlyOnceWith('smith-copilot');
  });

  it('does not infer idle when the OpenCode binding has not been persisted', async () => {
    // Given
    const unbound = { ...openCode, agentSessionId: null };
    // When
    const result = readSessionState(unbound);
    // Then
    await expect(result).rejects.toThrow('conversation has not been recorded');
    expect(getOpenCodeState).not.toHaveBeenCalled();
  });

  it('preserves failed API state while other sessions and archive reaping continue', async () => {
    // Given
    vi.mocked(getOpenCodeState).mockRejectedValue(new Error('API unavailable'));
    const onStateChange = vi.fn();
    const onDied = vi.fn();
    const onReap = vi.fn().mockResolvedValue(undefined);
    poller = new StatePoller({ pollMs: 3000, getSessionIds: () => [openCode, copilot], onStateChange, onDied, onReap });
    poller.start();
    // When
    await vi.advanceTimersByTimeAsync(3000);
    // Then
    expect(onStateChange).toHaveBeenCalledExactlyOnceWith('copilot', 'idle');
    expect(onDied).not.toHaveBeenCalled();
    expect(onReap).toHaveBeenCalledWith(new Set(['smith-open', 'smith-copilot']));
  });

  it('treats a missing OpenCode server or terminal as death even if tmux itself is still alive', async () => {
    // Given
    vi.mocked(isAgentTmuxAlive).mockResolvedValue(false);
    const onDied = vi.fn();
    poller = new StatePoller({
      pollMs: 3000, getSessionIds: () => [openCode], onStateChange: vi.fn(), onDied,
      onReap: vi.fn().mockResolvedValue(undefined),
    });
    poller.start();
    // When
    await vi.advanceTimersByTimeAsync(3000);
    // Then
    expect(onDied).toHaveBeenCalledExactlyOnceWith('open');
    expect(getOpenCodeState).not.toHaveBeenCalled();
  });
});
