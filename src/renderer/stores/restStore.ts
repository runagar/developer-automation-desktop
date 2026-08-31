import { create } from 'zustand';
import {
  ApiDocsContractType, ApiDocsOperationRow, ApiDocsRestSelection, ApiDocsServiceVersions,
} from '../../main/types';

const SELECTION_KEY = 'dad-rest-selection';

export type PickerLevel = 'services' | 'versions' | 'operations';

/** The seven fields that let DAD re-find a selection after a restart. */
export interface SelectionIdentity {
  service: string;
  category: string;
  type: ApiDocsContractType;
  version: string;
  method: string;
  path: string;
  acceptVersion: string | null;
}

export interface VersionRef {
  name: string;
  type: ApiDocsContractType;
}

interface RestStore {
  level: PickerLevel;
  search: string;

  services: string[];
  versions: ApiDocsServiceVersions | null;
  operations: ApiDocsOperationRow[];

  selectedService: string | null;
  selectedVersion: VersionRef | null;

  expanded: { releases: boolean; prereleases: boolean; branches: boolean };
  /** Tags the user has collapsed. Absent means expanded — tags start open. */
  collapsedTags: Record<string, boolean>;

  selection: ApiDocsRestSelection | null;
  /**
   * A persisted selection that could not be resolved yet — the contract fetch
   * failed because login is latched, missing or off VPN. Kept so a valid
   * selection is not silently discarded, and retried once auth recovers.
   */
  pendingSelection: SelectionIdentity | null;

  loading: boolean;
  error: string | null;

  setSearch: (value: string) => void;
  toggleSection: (section: 'releases' | 'prereleases' | 'branches') => void;
  toggleTag: (tag: string) => void;
  setAllTagsCollapsed: (tags: string[], collapsed: boolean) => void;

  loadServices: (force?: boolean) => Promise<void>;
  openService: (service: string) => Promise<void>;
  openVersion: (version: VersionRef) => Promise<void>;
  selectOperation: (row: ApiDocsOperationRow, acceptVersion: string | null) => Promise<void>;

  goToServices: () => void;
  goToVersions: () => void;
  refresh: () => Promise<void>;
  restoreSelection: () => Promise<void>;
  clearError: () => void;
}

export function rowKeyOf(row: { method: string; path: string }): string {
  return `${row.method} ${row.path}`;
}

/**
 * All terms must match, in any order, case-insensitively, against the service
 * name only (requirement 2.2, ambiguity 9).
 */
export function matchesSearch(name: string, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = name.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

export function filterServices(services: string[], query: string): string[] {
  return services.filter((name) => matchesSearch(name, query));
}

function loadIdentity(): SelectionIdentity | null {
  try {
    const raw = localStorage.getItem(SELECTION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.service !== 'string' || typeof parsed?.version !== 'string'
      || typeof parsed?.method !== 'string' || typeof parsed?.path !== 'string'
      || !['RELEASE', 'PRERELEASE', 'BRANCH'].includes(parsed?.type)
    ) return null;
    return {
      service: parsed.service,
      category: typeof parsed.category === 'string' ? parsed.category : 'default',
      type: parsed.type,
      version: parsed.version,
      method: parsed.method,
      path: parsed.path,
      acceptVersion: typeof parsed.acceptVersion === 'string' ? parsed.acceptVersion : null,
    };
  } catch {
    return null;
  }
}

function saveIdentity(identity: SelectionIdentity | null): void {
  try {
    if (identity) localStorage.setItem(SELECTION_KEY, JSON.stringify(identity));
    else localStorage.removeItem(SELECTION_KEY);
  } catch {
    // Storage unavailable or full — the selection simply will not be restored.
  }
}

function identityOf(selection: ApiDocsRestSelection): SelectionIdentity {
  return {
    service: selection.serviceName,
    category: selection.category,
    type: selection.contractType,
    version: selection.contractVersion,
    method: selection.method,
    path: selection.path,
    acceptVersion: selection.acceptVersion,
  };
}

function messageOf(err: unknown): string {
  const raw = (err as any)?.message ?? 'Request failed';
  // Electron prefixes IPC rejections with the handler frame; the useful part is
  // whatever the main process actually threw.
  return String(raw).replace(/^Error invoking remote method '[^']+':\s*/, '');
}

export const useRestStore = create<RestStore>((set, get) => ({
  level: 'services',
  search: '',
  services: [],
  versions: null,
  operations: [],
  selectedService: null,
  selectedVersion: null,
  expanded: { releases: true, prereleases: false, branches: false },
  collapsedTags: {},
  selection: null,
  pendingSelection: loadIdentity(),
  loading: false,
  error: null,

  setSearch: (value) => set({ search: value }),

  toggleSection: (section) => set((s) => ({
    expanded: { ...s.expanded, [section]: !s.expanded[section] },
  })),

  toggleTag: (tag) => set((s) => ({
    collapsedTags: { ...s.collapsedTags, [tag]: !s.collapsedTags[tag] },
  })),

  setAllTagsCollapsed: (tags, collapsed) => set(() => ({
    // Rebuilt rather than merged, so tags from a previously viewed contract
    // cannot linger in the map.
    collapsedTags: Object.fromEntries(tags.map((tag) => [tag, collapsed])),
  })),

  loadServices: async (force = false) => {
    if (!force && get().services.length > 0) return;
    set({ loading: true, error: null });
    try {
      const services = await window.dad.apidocsServices();
      set({ services, loading: false });
    } catch (err) {
      set({ loading: false, error: messageOf(err) });
    }
  },

  openService: async (service) => {
    set({ loading: true, error: null, selectedService: service, level: 'versions' });
    try {
      const versions = await window.dad.apidocsVersions(service);
      set({ versions, loading: false });
    } catch (err) {
      set({ loading: false, error: messageOf(err) });
    }
  },

  openVersion: async (version) => {
    const service = get().selectedService;
    if (!service) return;
    set({ loading: true, error: null, selectedVersion: version, level: 'operations' });
    try {
      const operations = await window.dad.apidocsOperations(service, version.type, version.name);
      set({ operations, collapsedTags: {}, loading: false });
    } catch (err) {
      set({ loading: false, error: messageOf(err) });
    }
  },

  selectOperation: async (row, acceptVersion) => {
    const { selectedService, selectedVersion } = get();
    if (!selectedService || !selectedVersion) return;
    set({ loading: true, error: null });
    try {
      const selection = await window.dad.apidocsSelection(
        selectedService, selectedVersion.type, selectedVersion.name,
        row.method, row.path, acceptVersion
      );
      if (!selection) {
        set({ loading: false, error: 'That operation is no longer in the contract' });
        return;
      }
      saveIdentity(identityOf(selection));
      set({ selection, pendingSelection: null, loading: false });
    } catch (err) {
      set({ loading: false, error: messageOf(err) });
    }
  },

  goToServices: () => set({ level: 'services' }),

  goToVersions: () => set((s) => (s.selectedService ? { level: 'versions' } : {})),

  refresh: async () => {
    const { selectedService, selectedVersion, level, selection, pendingSelection } = get();
    set({ loading: true, error: null });
    try {
      await window.dad.apidocsRefresh();
      const services = await window.dad.apidocsServices();
      set({ services });

      // Reloading the current level matters as much as clearing the caches:
      // leaving the view showing evicted data would break the next lookup.
      if (selectedService && (level === 'versions' || level === 'operations')) {
        set({ versions: await window.dad.apidocsVersions(selectedService) });
      }
      if (selectedService && selectedVersion && level === 'operations') {
        set({
          operations: await window.dad.apidocsOperations(
            selectedService, selectedVersion.type, selectedVersion.name
          ),
        });
      }
      set({ loading: false });

      if (selection || pendingSelection) await get().restoreSelection();
    } catch (err) {
      set({ loading: false, error: messageOf(err) });
    }
  },

  restoreSelection: async () => {
    const identity = get().pendingSelection ?? loadIdentity();
    if (!identity) return;
    try {
      const selection = await window.dad.apidocsSelection(
        identity.service, identity.type, identity.version,
        identity.method, identity.path, identity.acceptVersion
      );
      if (selection) {
        set({ selection, pendingSelection: null });
      } else {
        // The contract loaded but no longer has this operation — a real
        // removal, so the stored identity is genuinely stale.
        saveIdentity(null);
        set({
          selection: null, pendingSelection: null,
          error: `${identity.method} ${identity.path} is no longer in ${identity.service} ${identity.version}`,
        });
      }
    } catch {
      // Could not reach api-docs (latched, no credentials, off VPN). Keep the
      // identity pending rather than discarding a selection that is probably
      // still valid.
      set({ pendingSelection: identity });
    }
  },

  clearError: () => set({ error: null }),
}));
