// Framework-agnostic dashboard grid math, types, and default layout.
// The workspace is a 24×24 virtual grid; placements are expressed in grid cells
// and converted to percentages so the layout scales with window size.

import { nanoid } from 'nanoid';

// ---------------------------------------------------------------------------
// Panel types & modes
// ---------------------------------------------------------------------------

export type PanelType = 'sessions' | 'terminal' | 'jira' | 'shell';

export type PanelMode = 'singleton' | 'default' | 'linked';

export const PANEL_LABELS: Record<PanelType, string> = {
  sessions: 'Sessions',
  terminal: 'CLI Terminal',
  jira: 'Jira',
  shell: 'Shell',
};

/** Types that only allow a single instance (toggle show/hide, never destroyed). */
export const SINGLETON_TYPES: Set<PanelType> = new Set(['sessions']);

// ---------------------------------------------------------------------------
// Placement & PanelInstance
// ---------------------------------------------------------------------------

export interface Placement {
  x: number;
  y: number;
  w: number;
  h: number;
  visible: boolean;
  z: number;
}

export interface PanelInstance {
  id: string;                // type-prefixed nanoid (e.g. "terminal-a8f3k2"), or "sessions" for the singleton
  type: PanelType;
  placement: Placement;
  mode: PanelMode;
  linkedSessionId?: string;  // set only when mode is 'linked'
  currentSessionId?: string; // what the panel is currently displaying
}

export interface DashboardState {
  instances: PanelInstance[];
  locked: boolean;
}

// ---------------------------------------------------------------------------
// Grid constants
// ---------------------------------------------------------------------------

export const GRID = 24;
export const MIN_CELLS = 1;

export const STORAGE_KEY = 'agent-smith-dashboard';

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export const toPct = (cells: number): number => (cells / GRID) * 100;

export function clampPlacement(p: Placement): Placement {
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

// ---------------------------------------------------------------------------
// Ordering & z-index
// ---------------------------------------------------------------------------

/**
 * Visible panel instances sorted in reading order (top-left → bottom-right),
 * with higher z winning ties at the same position. Used for Ctrl+Tab cycling.
 */
export function panelOrder(instances: PanelInstance[]): PanelInstance[] {
  return instances
    .filter((inst) => inst.placement.visible)
    .sort((a, b) => {
      const A = a.placement;
      const B = b.placement;
      if (A.y !== B.y) return A.y - B.y;
      if (A.x !== B.x) return A.x - B.x;
      return B.z - A.z;
    });
}

export function maxZ(instances: PanelInstance[]): number {
  if (instances.length === 0) return 0;
  return Math.max(...instances.map((inst) => inst.placement.z));
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

export function generatePanelId(type: PanelType): string {
  if (SINGLETON_TYPES.has(type)) return type; // e.g. "sessions"
  return `${type}-${nanoid(6)}`;
}

// ---------------------------------------------------------------------------
// Default layout (24×24)
// ---------------------------------------------------------------------------

export const DEFAULT_INSTANCES: PanelInstance[] = [
  {
    id: 'sessions',
    type: 'sessions',
    placement: { x: 0, y: 0, w: 4, h: 24, visible: true, z: 1 },
    mode: 'singleton',
  },
  {
    id: 'terminal-default',
    type: 'terminal',
    placement: { x: 4, y: 0, w: 14, h: 14, visible: true, z: 2 },
    mode: 'default',
  },
  {
    id: 'shell-default',
    type: 'shell',
    placement: { x: 4, y: 14, w: 14, h: 10, visible: true, z: 2 },
    mode: 'default',
  },
  {
    id: 'jira-default',
    type: 'jira',
    placement: { x: 18, y: 0, w: 6, h: 24, visible: true, z: 1 },
    mode: 'default',
  },
];

function cloneInstances(instances: PanelInstance[]): PanelInstance[] {
  return instances.map((inst) => ({
    ...inst,
    placement: { ...inst.placement },
  }));
}

export function defaultState(): DashboardState {
  return { instances: cloneInstances(DEFAULT_INSTANCES), locked: false };
}

// ---------------------------------------------------------------------------
// State validation & persistence migration
// ---------------------------------------------------------------------------

export function validateState(value: unknown): DashboardState | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;

  // Old schema had `layout` (Record<PanelId, Placement>); new schema has `instances` (array).
  if (!Array.isArray(v.instances)) return null;

  const instances: PanelInstance[] = [];
  for (const raw of v.instances) {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.type !== 'string' || typeof r.mode !== 'string') return null;
    const p = r.placement as Record<string, unknown> | undefined;
    if (
      !p ||
      typeof p.x !== 'number' || typeof p.y !== 'number' ||
      typeof p.w !== 'number' || typeof p.h !== 'number' ||
      typeof p.visible !== 'boolean' || typeof p.z !== 'number'
    ) {
      return null;
    }
    instances.push({
      id: r.id as string,
      type: r.type as PanelType,
      placement: clampPlacement({ x: p.x, y: p.y, w: p.w, h: p.h, visible: p.visible, z: p.z }),
      mode: r.mode as PanelMode,
      linkedSessionId: typeof r.linkedSessionId === 'string' ? r.linkedSessionId : undefined,
      currentSessionId: typeof r.currentSessionId === 'string' ? r.currentSessionId : undefined,
    });
  }

  // Must have at least the sessions singleton
  if (!instances.some((inst) => inst.type === 'sessions')) return null;

  return {
    instances,
    locked: typeof v.locked === 'boolean' ? v.locked : false,
  };
}

// ---------------------------------------------------------------------------
// Spawn placement algorithm
// ---------------------------------------------------------------------------

/**
 * Find placement for a new panel of the given type.
 *
 * Strategy order:
 * 1. Fill the first contiguous empty rectangle ≥ 2×2 (reading order).
 * 2. Split an existing panel of the same type (longest dimension halved).
 * 3. Overlay at centre with 3×3 size.
 *
 * Returns `{ placement, splitInstanceId? }` — if a split happened, the caller
 * must also update the source panel's placement.
 */
export function findSpawnPlacement(
  instances: PanelInstance[],
  type: PanelType,
): { placement: Placement; splitInstanceId?: string; splitPlacement?: Placement } {
  const currentMaxZ = maxZ(instances);

  // --- Strategy 1: empty space ---
  const occupied = buildOccupancyGrid(instances);
  const emptyRect = findFirstEmptyRect(occupied, 2, 2);
  if (emptyRect) {
    return {
      placement: {
        x: emptyRect.x,
        y: emptyRect.y,
        w: emptyRect.w,
        h: emptyRect.h,
        visible: true,
        z: currentMaxZ + 1,
      },
    };
  }

  // --- Strategy 2: split an existing panel of the same type ---
  const candidates = instances
    .filter((inst) => inst.type === type && inst.placement.w >= 2 && inst.placement.h >= 2)
    .sort((a, b) => {
      // Prefer larger panels to split
      const aArea = a.placement.w * a.placement.h;
      const bArea = b.placement.w * b.placement.h;
      return bArea - aArea;
    });

  if (candidates.length > 0) {
    const source = candidates[0];
    const sp = source.placement;
    // Halve the longest dimension (horizontal wins ties)
    if (sp.w >= sp.h) {
      // Split horizontally
      const keptW = Math.ceil(sp.w / 2);
      const newW = sp.w - keptW;
      return {
        placement: {
          x: sp.x + keptW,
          y: sp.y,
          w: newW,
          h: sp.h,
          visible: true,
          z: currentMaxZ + 1,
        },
        splitInstanceId: source.id,
        splitPlacement: { ...sp, w: keptW },
      };
    } else {
      // Split vertically
      const keptH = Math.ceil(sp.h / 2);
      const newH = sp.h - keptH;
      return {
        placement: {
          x: sp.x,
          y: sp.y + keptH,
          w: sp.w,
          h: newH,
          visible: true,
          z: currentMaxZ + 1,
        },
        splitInstanceId: source.id,
        splitPlacement: { ...sp, h: keptH },
      };
    }
  }

  // --- Strategy 3: centre overlay ---
  const cx = Math.round((GRID - 3) / 2);
  const cy = Math.round((GRID - 3) / 2);
  return {
    placement: { x: cx, y: cy, w: 3, h: 3, visible: true, z: currentMaxZ + 1 },
  };
}

// ---------------------------------------------------------------------------
// Occupancy grid helpers
// ---------------------------------------------------------------------------

function buildOccupancyGrid(instances: PanelInstance[]): boolean[][] {
  const grid: boolean[][] = Array.from({ length: GRID }, () => Array(GRID).fill(false));
  for (const inst of instances) {
    if (!inst.placement.visible) continue;
    const p = inst.placement;
    for (let r = p.y; r < p.y + p.h && r < GRID; r++) {
      for (let c = p.x; c < p.x + p.w && c < GRID; c++) {
        grid[r][c] = true;
      }
    }
  }
  return grid;
}

/**
 * Find the first contiguous empty rectangle of at least `minW × minH`
 * in reading order (scan rows top-down, then columns left-right).
 * Returns the maximal rectangle that starts at the first empty cell.
 */
function findFirstEmptyRect(
  grid: boolean[][],
  minW: number,
  minH: number,
): { x: number; y: number; w: number; h: number } | null {
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      if (grid[r][c]) continue;

      // Found an empty cell — expand rightward and downward
      let maxW = 0;
      while (c + maxW < GRID && !grid[r][c + maxW]) maxW++;
      if (maxW < minW) continue;

      let maxH = 0;
      outer:
      for (let dr = 0; r + dr < GRID; dr++) {
        for (let dc = 0; dc < maxW; dc++) {
          if (grid[r + dr][c + dc]) {
            // Narrow the width if we're still in the first row of expansion
            if (dr === 0) { maxW = dc; break outer; }
            break outer;
          }
        }
        maxH = dr + 1;
      }

      if (maxW >= minW && maxH >= minH) {
        return { x: c, y: r, w: maxW, h: maxH };
      }
    }
  }
  return null;
}
