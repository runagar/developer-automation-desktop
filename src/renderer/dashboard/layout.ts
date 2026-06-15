// Framework-agnostic dashboard grid math, types, presets, and default layout.
// The workspace is a 12x12 virtual grid; placements are expressed in grid cells
// and converted to percentages so the layout scales with window size.

export type PanelId = 'sessions' | 'terminal' | 'jira' | 'shell';

export const PANEL_IDS: PanelId[] = ['sessions', 'terminal', 'jira', 'shell'];

export const PANEL_LABELS: Record<PanelId, string> = {
  sessions: 'Sessions',
  terminal: 'Terminal',
  jira: 'Jira',
  shell: 'Shell',
};

export interface DashboardPanelPlacement {
  x: number; // column (0-11)
  y: number; // row (0-11)
  w: number; // width in columns
  h: number; // height in rows
  visible: boolean;
  z: number; // stacking order
}

export type DashboardLayout = Record<PanelId, DashboardPanelPlacement>;

export interface DashboardState {
  layout: DashboardLayout;
  locked: boolean;
  preset: string; // active preset name, or 'custom'
}

export const GRID = 12;
export const MIN_CELLS = 1;

export const STORAGE_KEY = 'agent-smith-dashboard';

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export const toPct = (cells: number): number => (cells / GRID) * 100;

export function clampPlacement(p: DashboardPanelPlacement): DashboardPanelPlacement {
  const w = clamp(Math.round(p.w), MIN_CELLS, GRID);
  const h = clamp(Math.round(p.h), MIN_CELLS, GRID);
  return {
    ...p,
    w,
    h,
    x: clamp(Math.round(p.x), 0, GRID - w),
    y: clamp(Math.round(p.y), 0, GRID - h),
  };
}

// Panels ordered for Ctrl+Tab cycling: grid reading order (top-left -> bottom-right),
// with higher-z (visually on top) winning ties at the same position.
export function panelOrder(layout: DashboardLayout): PanelId[] {
  return PANEL_IDS
    .filter((id) => layout[id].visible)
    .sort((a, b) => {
      const A = layout[a];
      const B = layout[b];
      if (A.y !== B.y) return A.y - B.y;
      if (A.x !== B.x) return A.x - B.x;
      return B.z - A.z;
    });
}

export function maxZ(layout: DashboardLayout): number {
  return Math.max(...PANEL_IDS.map((id) => layout[id].z));
}

// --- Layouts & presets ---

export const DEFAULT_LAYOUT: DashboardLayout = {
  sessions: { x: 0, y: 0, w: 2, h: 12, visible: true, z: 1 },
  terminal: { x: 2, y: 0, w: 7, h: 12, visible: true, z: 2 },
  jira: { x: 9, y: 0, w: 3, h: 12, visible: true, z: 1 },
  shell: { x: 2, y: 0, w: 7, h: 12, visible: false, z: 0 },
};

export interface LayoutPreset {
  name: string;
  layout: DashboardLayout;
}

export const PRESETS: LayoutPreset[] = [
  {
    name: 'List Left',
    layout: DEFAULT_LAYOUT,
  },
  {
    name: 'Classic',
    layout: {
      terminal: { x: 0, y: 0, w: 7, h: 12, visible: true, z: 2 },
      sessions: { x: 7, y: 0, w: 2, h: 12, visible: true, z: 1 },
      jira: { x: 9, y: 0, w: 3, h: 12, visible: true, z: 1 },
      shell: { x: 0, y: 0, w: 7, h: 12, visible: false, z: 0 },
    },
  },
  {
    name: 'Terminal Bottom',
    layout: {
      sessions: { x: 0, y: 0, w: 6, h: 5, visible: true, z: 1 },
      jira: { x: 6, y: 0, w: 6, h: 5, visible: true, z: 1 },
      terminal: { x: 0, y: 5, w: 12, h: 7, visible: true, z: 2 },
      shell: { x: 0, y: 5, w: 12, h: 7, visible: false, z: 0 },
    },
  },
  {
    name: 'Focus Terminal',
    layout: {
      sessions: { x: 0, y: 0, w: 2, h: 12, visible: true, z: 1 },
      terminal: { x: 2, y: 0, w: 10, h: 12, visible: true, z: 2 },
      jira: { x: 9, y: 0, w: 3, h: 12, visible: false, z: 1 },
      shell: { x: 2, y: 0, w: 10, h: 12, visible: false, z: 0 },
    },
  },
  {
    name: 'Dev',
    layout: {
      sessions: { x: 0, y: 0, w: 2, h: 12, visible: true, z: 1 },
      terminal: { x: 2, y: 0, w: 7, h: 6, visible: true, z: 2 },
      shell: { x: 2, y: 6, w: 7, h: 6, visible: true, z: 2 },
      jira: { x: 9, y: 0, w: 3, h: 12, visible: true, z: 1 },
    },
  },
];

export const DEFAULT_PRESET = PRESETS[0].name;

// Deep clone a layout so presets/defaults are never mutated by reference.
export function cloneLayout(layout: DashboardLayout): DashboardLayout {
  const out = {} as DashboardLayout;
  for (const id of PANEL_IDS) {
    out[id] = { ...layout[id] };
  }
  return out;
}

export function defaultState(): DashboardState {
  return { layout: cloneLayout(DEFAULT_LAYOUT), locked: false, preset: DEFAULT_PRESET };
}

// Validate a parsed value against the current schema. Returns a safe state or null.
export function validateState(value: unknown): DashboardState | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const layout = v.layout as Record<string, unknown> | undefined;
  if (!layout) return null;

  const out = {} as DashboardLayout;
  for (const id of PANEL_IDS) {
    const p = layout[id] as Record<string, unknown> | undefined;
    if (!p) {
      // Missing panel (e.g. saved layout from before shell was added) —
      // inject default placement instead of rejecting the whole state.
      out[id] = { ...DEFAULT_LAYOUT[id] };
      continue;
    }
    if (
      typeof p.x !== 'number' || typeof p.y !== 'number' ||
      typeof p.w !== 'number' || typeof p.h !== 'number' ||
      typeof p.visible !== 'boolean' || typeof p.z !== 'number'
    ) {
      return null;
    }
    out[id] = clampPlacement({
      x: p.x, y: p.y, w: p.w, h: p.h, visible: p.visible, z: p.z,
    });
  }

  return {
    layout: out,
    locked: typeof v.locked === 'boolean' ? v.locked : false,
    preset: typeof v.preset === 'string' ? v.preset : DEFAULT_PRESET,
  };
}
