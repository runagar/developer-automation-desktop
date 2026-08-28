import { describe, it, expect } from 'vitest';
import {
  defaultState, validateState, isTypeAllowed, tabDef,
  PanelInstance, DashboardState,
} from './layout';

function serialize(state: DashboardState): unknown {
  return JSON.parse(JSON.stringify({ instances: state.instances, locked: state.locked }));
}

function globalNote(id: string, contentId?: string): PanelInstance {
  return {
    id,
    contentId,
    type: 'notes',
    placement: { x: 0, y: 0, w: 6, h: 6, visible: true, z: 1 },
    mode: 'linked',
    isGlobal: true,
    name: 'A note',
  };
}

describe('tab definitions', () => {
  it('allows each tab only its own panel types', () => {
    expect(isTypeAllowed('agent-smith', 'terminal')).toBe(true);
    expect(isTypeAllowed('agent-smith', 'api-picker')).toBe(false);
    expect(isTypeAllowed('rest-room', 'api-picker')).toBe(true);
    expect(isTypeAllowed('rest-room', 'terminal')).toBe(false);
  });

  it('supports notes in both tabs', () => {
    expect(isTypeAllowed('agent-smith', 'notes')).toBe(true);
    expect(isTypeAllowed('rest-room', 'notes')).toBe(true);
  });
});

describe('defaultState', () => {
  it('boots rest-room with its three singletons and no sessions panel', () => {
    const state = defaultState('rest-room');
    expect(state.instances.map((i) => i.type).sort()).toEqual(
      ['api-picker', 'rest-crafter', 'rest-response']
    );
    expect(state.instances.some((i) => i.type === 'sessions')).toBe(false);
  });

  it('boots agent-smith with its own default layout', () => {
    const state = defaultState('agent-smith');
    expect(state.instances.map((i) => i.type)).toEqual(
      ['sessions', 'terminal', 'shell', 'jira']
    );
  });

  it('returns an independent copy each call', () => {
    const a = defaultState('rest-room');
    a.instances[0].placement.x = 99;
    expect(defaultState('rest-room').instances[0].placement.x).toBe(0);
    expect(tabDef('rest-room').defaultInstances[0].placement.x).toBe(0);
  });
});

describe('validateState', () => {
  it('accepts a rest-room layout that has no sessions panel', () => {
    const parsed = validateState(serialize(defaultState('rest-room')), 'rest-room');
    expect(parsed).not.toBeNull();
    expect(parsed!.instances).toHaveLength(3);
  });

  it('drops panel types the target tab does not allow', () => {
    const raw = serialize(defaultState('agent-smith')) as { instances: PanelInstance[] };
    const parsed = validateState(raw, 'rest-room');
    expect(parsed).not.toBeNull();
    // Every agent-smith type is disallowed in rest-room, so all are dropped and
    // the three rest-room singletons are repaired back in.
    expect(parsed!.instances.map((i) => i.type).sort()).toEqual(
      ['api-picker', 'rest-crafter', 'rest-response']
    );
  });

  it('re-inserts a missing singleton instead of discarding the whole layout', () => {
    const raw = serialize(defaultState('rest-room')) as { instances: PanelInstance[] };
    raw.instances = raw.instances.filter((i) => i.type !== 'rest-response');
    const parsed = validateState(raw, 'rest-room');
    expect(parsed).not.toBeNull();
    expect(parsed!.instances.some((i) => i.type === 'rest-response')).toBe(true);
  });

  it('backfills contentId from id for legacy global notes panels', () => {
    const legacy = globalNote('notes-abc123');
    delete (legacy as { contentId?: string }).contentId;
    const parsed = validateState(
      { instances: [legacy], locked: false },
      'agent-smith'
    );
    expect(parsed!.instances.find((i) => i.type === 'notes')!.contentId).toBe('notes-abc123');
  });

  it('does not invent a contentId for non-notes panels', () => {
    const parsed = validateState(serialize(defaultState('agent-smith')), 'agent-smith');
    expect(parsed!.instances.every((i) => i.contentId === undefined)).toBe(true);
  });

  it('preserves the contentId of two views of the same note across a round-trip', () => {
    // Regression guard: overwriting contentId with the instance id here would
    // silently desync the two views — mirroring stops and one loads empty.
    const state: DashboardState = {
      instances: [globalNote('notes-viewA', 'note-row-1'), globalNote('notes-viewB', 'note-row-1')],
      locked: false,
    };
    const parsed = validateState(serialize(state), 'agent-smith');
    const notes = parsed!.instances.filter((i) => i.type === 'notes');
    expect(notes.map((i) => i.contentId)).toEqual(['note-row-1', 'note-row-1']);
    expect(notes.map((i) => i.id)).toEqual(['notes-viewA', 'notes-viewB']);
  });

  it('rejects a payload that is not the instances schema', () => {
    expect(validateState(null, 'agent-smith')).toBeNull();
    expect(validateState({ layout: {} }, 'agent-smith')).toBeNull();
  });
});
