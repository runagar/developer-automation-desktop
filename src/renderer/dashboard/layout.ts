// Framework-agnostic dashboard grid math, types, and default layout.
// The workspace is a 24×24 virtual grid; placements are expressed in grid cells
// and converted to percentages so the layout scales with window size.

import { nanoid } from 'nanoid';

// ---------------------------------------------------------------------------
// Panel types & modes
// ---------------------------------------------------------------------------

export type PanelType = 'sessions' | 'terminal' | 'jira' | 'shell' | 'notes';

export type PanelMode = 'singleton' | 'default' | 'linked';

export const PANEL_LABELS: Record<PanelType, string> = {
  sessions: 'Sessions',
  terminal: 'CLI Terminal',
  jira: 'Jira',
  shell: 'Shell',
  notes: 'Notes',
};

/** Types that only allow a single instance (toggle show/hide, never destroyed). */
export const SINGLETON_TYPES: Set<PanelType> = new Set(['sessions']);

/** Types that can be spawned as global (session-unbound) panels. */
export const GLOBAL_CAPABLE_TYPES: Set<PanelType> = new Set(['notes']);

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
  isGlobal?: boolean;        // true for global panels (no session binding)
  name?: string;             // user-facing name (global notes panels)
  preMaximizePlacement?: Placement; // stored when panel is maximized, for restore
}

export interface DashboardState {
  instances: PanelInstance[];
  locked: boolean;
}

// ---------------------------------------------------------------------------
// Grid constants
// ---------------------------------------------------------------------------

export const GRID = 24;
export const MIN_W = 2;
export const MIN_H = 3;

export const STORAGE_KEY = 'agent-smith-dashboard';

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export const toPct = (cells: number): number => (cells / GRID) * 100;

export function clampPlacement(p: Placement): Placement {
  const w = clamp(Math.round(p.w), MIN_W, GRID);
  const h = clamp(Math.round(p.h), MIN_H, GRID);
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
      isGlobal: r.isGlobal === true ? true : undefined,
      name: typeof r.name === 'string' ? r.name : undefined,
      preMaximizePlacement: r.preMaximizePlacement && typeof r.preMaximizePlacement === 'object'
        ? clampPlacement(r.preMaximizePlacement as Placement)
        : undefined,
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
  const emptyRect = findFirstEmptyRect(occupied, MIN_W, MIN_H);
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
  // A panel is splittable if halving its longest dimension still leaves both halves >= minimum.
  // Horizontal split needs: w >= MIN_W * 2, h >= MIN_H
  // Vertical split needs: h >= MIN_H * 2, w >= MIN_W
  const candidates = instances
    .filter((inst) => {
      if (inst.type !== type) return false;
      const p = inst.placement;
      const canSplitH = p.w >= MIN_W * 2 && p.h >= MIN_H;
      const canSplitV = p.h >= MIN_H * 2 && p.w >= MIN_W;
      return canSplitH || canSplitV;
    })
    .sort((a, b) => {
      // Prefer larger panels to split
      const aArea = a.placement.w * a.placement.h;
      const bArea = b.placement.w * b.placement.h;
      return bArea - aArea;
    });

  if (candidates.length > 0) {
    const source = candidates[0];
    const sp = source.placement;
    const canSplitH = sp.w >= MIN_W * 2 && sp.h >= MIN_H;
    const canSplitV = sp.h >= MIN_H * 2 && sp.w >= MIN_W;
    // Prefer splitting the longest dimension; fall back to whichever is possible
    const splitHorizontally = canSplitH && (!canSplitV || sp.w >= sp.h);
    if (splitHorizontally) {
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

// ---------------------------------------------------------------------------
// Maximize / Expand algorithms
// ---------------------------------------------------------------------------

/**
 * Build an occupancy grid excluding a specific panel (so we can compute
 * expansion for that panel ignoring its own footprint).
 */
function buildOccupancyGridExcluding(instances: PanelInstance[], excludeId: string): boolean[][] {
  const grid: boolean[][] = Array.from({ length: GRID }, () => Array(GRID).fill(false));
  for (const inst of instances) {
    if (!inst.placement.visible || inst.id === excludeId) continue;
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
 * Compute the maximum rectangular expansion of a panel into empty space.
 * The result is the largest rectangle containing the panel's current position
 * that doesn't overlap any other visible panel.
 *
 * Strategy: expand each edge outward as far as possible, then find the
 * largest rectangle that includes the original panel. Prioritize expansion
 * in the shortest dimension, tie-break horizontal.
 *
 * Returns the expanded placement, or null if no expansion is possible.
 */
export function computeMaxExpansion(instances: PanelInstance[], panelId: string): Placement | null {
  const inst = instances.find((i) => i.id === panelId);
  if (!inst) return null;
  const p = inst.placement;

  const grid = buildOccupancyGridExcluding(instances, panelId);

  // Find how far we can expand in each direction
  // Expand left: find min x where all rows in [p.y, p.y+p.h) are free
  let minX = p.x;
  expandLeft:
  for (let c = p.x - 1; c >= 0; c--) {
    for (let r = p.y; r < p.y + p.h; r++) {
      if (grid[r][c]) break expandLeft;
    }
    minX = c;
  }

  // Expand right
  let maxX = p.x + p.w - 1;
  expandRight:
  for (let c = p.x + p.w; c < GRID; c++) {
    for (let r = p.y; r < p.y + p.h; r++) {
      if (grid[r][c]) break expandRight;
    }
    maxX = c;
  }

  // Expand up (using the full horizontal range we found)
  let minY = p.y;
  expandUp:
  for (let r = p.y - 1; r >= 0; r--) {
    for (let c = minX; c <= maxX; c++) {
      if (grid[r][c]) break expandUp;
    }
    minY = r;
  }

  // Expand down (using the full horizontal range)
  let maxY = p.y + p.h - 1;
  expandDown:
  for (let r = p.y + p.h; r < GRID; r++) {
    for (let c = minX; c <= maxX; c++) {
      if (grid[r][c]) break expandDown;
    }
    maxY = r;
  }

  // Also try expanding vertically first, then horizontally (to get a different result)
  let minY2 = p.y;
  expandUp2:
  for (let r = p.y - 1; r >= 0; r--) {
    for (let c = p.x; c < p.x + p.w; c++) {
      if (grid[r][c]) break expandUp2;
    }
    minY2 = r;
  }

  let maxY2 = p.y + p.h - 1;
  expandDown2:
  for (let r = p.y + p.h; r < GRID; r++) {
    for (let c = p.x; c < p.x + p.w; c++) {
      if (grid[r][c]) break expandDown2;
    }
    maxY2 = r;
  }

  let minX2 = p.x;
  expandLeft2:
  for (let c = p.x - 1; c >= 0; c--) {
    for (let r = minY2; r <= maxY2; r++) {
      if (grid[r][c]) break expandLeft2;
    }
    minX2 = c;
  }

  let maxX2 = p.x + p.w - 1;
  expandRight2:
  for (let c = p.x + p.w; c < GRID; c++) {
    for (let r = minY2; r <= maxY2; r++) {
      if (grid[r][c]) break expandRight2;
    }
    maxX2 = c;
  }

  // Candidate 1: horizontal-first expansion
  const c1 = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  // Candidate 2: vertical-first expansion
  const c2 = { x: minX2, y: minY2, w: maxX2 - minX2 + 1, h: maxY2 - minY2 + 1 };

  // Pick the better candidate: prefer expanding the shorter dimension
  const candidates = [c1, c2].filter((c) => c.w > p.w || c.h > p.h);
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const aArea = a.w * a.h;
    const bArea = b.w * b.h;
    if (aArea !== bArea) return bArea - aArea; // Prefer larger area

    // Same area: prefer the one that grows the shorter dimension more
    const aShortGrowth = p.w <= p.h ? (a.w - p.w) : (a.h - p.h);
    const bShortGrowth = p.w <= p.h ? (b.w - p.w) : (b.h - p.h);
    if (aShortGrowth !== bShortGrowth) return bShortGrowth - aShortGrowth;

    // Tie: prefer horizontal growth
    return (b.w - p.w) - (a.w - p.w);
  });

  const best = candidates[0];
  // Return only if it's actually larger than current
  if (best.w === p.w && best.h === p.h) return null;

  return { ...p, x: best.x, y: best.y, w: best.w, h: best.h };
}

/**
 * After closing a panel, find a same-type neighbour that can expand into
 * the freed space (fully or partially). Returns the id and new placement,
 * or null if no candidate can fill.
 */
export function findCloseExpandCandidate(
  instances: PanelInstance[],
  closedPanel: PanelInstance,
): { id: string; placement: Placement } | null {
  // After the closed panel is removed, compute what each same-type neighbour
  // could expand into. The "freed space" is the cells previously occupied by
  // the closed panel that are not occupied by any other panel.
  const remainingInstances = instances.filter((i) => i.id !== closedPanel.id);
  const sameType = remainingInstances.filter(
    (i) => i.type === closedPanel.type && i.placement.visible
  );
  if (sameType.length === 0) return null;

  // For each same-type panel, compute its max expansion with the closed panel removed
  const candidates: Array<{ id: string; placement: Placement; wGrowth: number; hGrowth: number }> = [];

  for (const panel of sameType) {
    const expanded = computeMaxExpansion(remainingInstances, panel.id);
    if (!expanded) continue;
    // Only accept if the expansion actually covers at least part of the freed space
    const cp = closedPanel.placement;
    const overlapX = Math.max(0, Math.min(expanded.x + expanded.w, cp.x + cp.w) - Math.max(expanded.x, cp.x));
    const overlapY = Math.max(0, Math.min(expanded.y + expanded.h, cp.y + cp.h) - Math.max(expanded.y, cp.y));
    if (overlapX <= 0 || overlapY <= 0) continue;

    candidates.push({
      id: panel.id,
      placement: { ...panel.placement, x: expanded.x, y: expanded.y, w: expanded.w, h: expanded.h },
      wGrowth: expanded.w - panel.placement.w,
      hGrowth: expanded.h - panel.placement.h,
    });
  }

  if (candidates.length === 0) return null;

  // Sort: prefer growth in shortest dimension, tie → horizontal, still tie → reading order
  candidates.sort((a, b) => {
    const panelA = sameType.find((i) => i.id === a.id)!;
    const panelB = sameType.find((i) => i.id === b.id)!;

    // Prefer the one whose growth is in its shorter dimension
    const aGrowsShort = panelA.placement.w <= panelA.placement.h ? a.wGrowth > 0 : a.hGrowth > 0;
    const bGrowsShort = panelB.placement.w <= panelB.placement.h ? b.wGrowth > 0 : b.hGrowth > 0;
    if (aGrowsShort !== bGrowsShort) return aGrowsShort ? -1 : 1;

    // Tie: prefer horizontal growth
    if (a.wGrowth !== b.wGrowth) return b.wGrowth - a.wGrowth;

    // Still tie: reading order (top-left first)
    if (panelA.placement.y !== panelB.placement.y) return panelA.placement.y - panelB.placement.y;
    return panelA.placement.x - panelB.placement.x;
  });

  return { id: candidates[0].id, placement: candidates[0].placement };
}
