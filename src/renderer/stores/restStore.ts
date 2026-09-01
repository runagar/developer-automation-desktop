import { create } from 'zustand';
import {
  ApiDocsContractType, ApiDocsOperationRow, ApiDocsRestSelection, ApiDocsServiceVersions,
  RestEnvironmentInfo, RestResultInfo,
} from '../../main/types';
import {
  ACCEPT, AUTHORIZATION, CustomHeader, CustomParam, carryOverValues, craftedPath,
  defaultHeaderRows, defaultParamRows, keepEditedBody, missingPathParams, requestHeaders,
} from './restCraft';

const SELECTION_KEY = 'dad-rest-selection';
const DRAFT_KEY = 'dad-rest-draft';
/** A draft larger than this is a runaway body, not something worth restoring. */
const DRAFT_LIMIT = 256 * 1024;
const DEFAULT_ENVIRONMENT = 'p0';

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

export type CrafterTab = 'headers' | 'parameters' | 'body';

/**
 * One executed request and its reply.
 *
 * Held in memory only: requirement 3 drops the whole history on restart, so
 * there is no storage layer for these at all.
 */
export interface ResponseTab {
  id: string;
  /** The api-path, shown as the tab title. */
  title: string;
  /** Full URL, for the tooltip and the header line. */
  url: string;
  method: string;
  /** True between a link click and its reply arriving. */
  loading: boolean;
  result: RestResultInfo | null;
  origin: 'crafter' | 'link';
}

/**
 * The parts of a crafted request that are worth surviving a restart.
 *
 * The Authorization value is deliberately absent: requirement 6.2.3 lets the
 * bearer token reach the renderer, but it must still never be written to disk.
 */
export interface RequestDraft {
  environmentKey: string;
  headerValues: Record<string, string>;
  customHeaders: CustomHeader[];
  paramValues: Record<string, string>;
  customParams: CustomParam[];
  bodyText: string;
  bodyEdited: boolean;
  /**
   * The skeleton the persisted body was edited against.
   *
   * Without it, a restart would compare an edited body against an empty
   * previous skeleton, decide the body no longer belongs to the operation and
   * overwrite the very thing the draft exists to preserve.
   */
  bodySkeletonBaseline: string;
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

  // --- REST Crafter (R3) ---
  environments: RestEnvironmentInfo[];
  environmentKey: string;
  /** The full `Bearer …` value, held in memory only. */
  authValue: string;
  /** True once the user hand-edits Authorization; suppresses automatic writes. */
  authManual: boolean;
  headerValues: Record<string, string>;
  customHeaders: CustomHeader[];
  paramValues: Record<string, string>;
  customParams: CustomParam[];
  bodyText: string;
  bodyEdited: boolean;
  bodySkeletonBaseline: string;
  activeTab: CrafterTab;
  tokenLoading: boolean;
  sending: boolean;
  crafterError: string | null;

  /**
   * Every response of this session, oldest first. Deliberately unbounded
   * (ambiguity 1) — a tab is removed only when the user closes it.
   */
  responses: ResponseTab[];
  activeResponseId: string | null;

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

  // --- REST Crafter (R3) ---
  loadEnvironments: () => Promise<void>;
  setEnvironment: (key: string) => Promise<void>;
  setAuthValue: (value: string) => void;
  resetAuth: () => Promise<void>;
  setHeaderValue: (key: string, value: string) => void;
  addCustomHeader: () => void;
  updateCustomHeader: (id: string, patch: Partial<CustomHeader>) => void;
  removeCustomHeader: (id: string) => void;
  setParamValue: (key: string, value: string) => void;
  addCustomParam: () => void;
  updateCustomParam: (id: string, patch: Partial<CustomParam>) => void;
  removeCustomParam: (id: string) => void;
  setBodyText: (text: string, fromUser: boolean) => void;
  setActiveTab: (tab: CrafterTab) => void;
  send: () => Promise<void>;
  clearCrafterError: () => void;

  // --- REST Response (R4) ---
  addResponseTab: (tab: Omit<ResponseTab, 'id'>) => string;
  copyLinkToCrafter: (tabId: string) => void;
  settleResponseTab: (id: string, result: RestResultInfo) => void;
  closeResponseTab: (id: string) => void;
  setActiveResponse: (id: string) => void;
  followLink: (url: string) => Promise<void>;
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

// ---------------------------------------------------------------------------
// Request draft persistence (ambiguity 23)
// ---------------------------------------------------------------------------

function isStringMap(value: unknown): value is Record<string, string> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every((v) => typeof v === 'string');
}

function isEntryList(value: unknown): value is CustomHeader[] {
  return Array.isArray(value) && value.every((e) =>
    e !== null && typeof e === 'object'
    && typeof (e as any).id === 'string'
    && typeof (e as any).name === 'string'
    && typeof (e as any).value === 'string');
}

export function parseDraft(raw: string | null): RequestDraft | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return null;
    if (typeof parsed.environmentKey !== 'string') return null;
    if (typeof parsed.bodyText !== 'string') return null;
    if (!isStringMap(parsed.headerValues) || !isStringMap(parsed.paramValues)) return null;
    if (!isEntryList(parsed.customHeaders) || !isEntryList(parsed.customParams)) return null;
    return {
      environmentKey: parsed.environmentKey,
      headerValues: parsed.headerValues,
      customHeaders: parsed.customHeaders,
      paramValues: parsed.paramValues,
      customParams: parsed.customParams,
      bodyText: parsed.bodyText,
      bodyEdited: parsed.bodyEdited === true,
      bodySkeletonBaseline: typeof parsed.bodySkeletonBaseline === 'string'
        ? parsed.bodySkeletonBaseline : '',
    };
  } catch {
    return null;
  }
}

function loadDraft(): RequestDraft | null {
  try {
    return parseDraft(localStorage.getItem(DRAFT_KEY));
  } catch {
    return null;
  }
}

let draftTimer: ReturnType<typeof setTimeout> | null = null;

export function serializeDraft(draft: RequestDraft): string | null {
  const json = JSON.stringify(draft);
  // A runaway body would otherwise be written on every keystroke.
  return json.length > DRAFT_LIMIT ? null : json;
}

function saveDraft(draft: RequestDraft): void {
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    try {
      const json = serializeDraft(draft);
      if (json) localStorage.setItem(DRAFT_KEY, json);
      else localStorage.removeItem(DRAFT_KEY);
    } catch {
      // Storage unavailable or full — the draft simply will not be restored.
    }
  }, 300);
}

/**
 * The `Accept` a followed link is tried with.
 *
 * A link crosses into a service whose accept-version cannot be discovered:
 * `*` / `*` and plain `application/json` are both refused by strict services with
 * "missing version information", the 406 names no supported version, `OPTIONS`
 * reveals nothing, and the target service may not be published in api-docs at
 * all. Rather than guess, DAD tries the most common version and offers
 * "copy to crafter" so the user can set whatever the service actually wants.
 */
export const LINK_ACCEPT = 'application/json;v=1';

/**
 * A stand-in selection for a followed link.
 *
 * The Crafter is built around an operation picked from a contract, but a link
 * is a bare URL with no contract behind it — possibly to a service that is not
 * in api-docs at all. This fabricates just enough for the Crafter to render
 * and send, leaving the user to set the accept-version themselves.
 */
export function selectionFromUrl(url: string): ApiDocsRestSelection {
  let pathname = url;
  let service = url;
  try {
    const parsed = new URL(url);
    pathname = parsed.pathname;
    service = pathname.split('/').filter(Boolean)[0] ?? parsed.host;
  } catch {
    // Not a URL — keep the raw string so the Crafter still shows something.
  }
  return {
    serviceName: service,
    category: 'default',
    contractType: 'RELEASE',
    contractVersion: 'link',
    method: 'GET',
    path: pathname,
    fullPath: pathname,
    acceptVersion: '1',
    acceptHeader: LINK_ACCEPT,
    produces: [],
    consumesVersion: null,
    consumesHeader: null,
    consumes: [],
    requestBodySchema: null,
    bodySkeleton: '',
    // No contract, so no declared parameters; the query string becomes custom
    // rows instead, and the path is already concrete.
    parameters: [],
    deprecated: false,
    summary: 'Followed link',
  };
}

/** Query parameters of a URL, as the Crafter's custom-parameter rows. */
export function customParamsFromUrl(url: string): CustomParam[] {
  try {
    const params = [...new URL(url).searchParams.entries()];
    return params.map(([name, value], i) => ({ id: `link-${i}`, name, value }));
  } catch {
    return [];
  }
}

/** The path and query of a URL, used as a response tab's title. */
export function pathOfUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

type SetState = (patch: Partial<RestStore>) => void;
type GetState = () => RestStore;

function persist(state: RestStore): void {
  saveDraft({
    environmentKey: state.environmentKey,
    headerValues: state.headerValues,
    customHeaders: state.customHeaders,
    paramValues: state.paramValues,
    customParams: state.customParams,
    bodyText: state.bodyText,
    bodyEdited: state.bodyEdited,
    bodySkeletonBaseline: state.bodySkeletonBaseline,
  });
}

/**
 * At most one token acquisition at a time.
 *
 * `getToken` already deduplicates callers for the *same* environment, and its
 * rejection latch blocks every *subsequent* environment once a credential has
 * been refused. What neither covers is several acquisitions to different
 * security hosts firing in the same tick — for instance from clicking quickly
 * through the environment list — which with a rotated password would mean
 * several failed domain authentications at once. This guard closes that.
 */
let tokenRequestInFlight = false;

async function fetchToken(set: SetState, get: GetState, key: string): Promise<void> {
  if (tokenRequestInFlight) return;
  tokenRequestInFlight = true;
  set({ tokenLoading: true });
  try {
    const token = await window.dad.restToken(key);
    // The user may have moved on while this was in flight; writing now would
    // show a token belonging to an environment that is no longer selected.
    if (get().environmentKey === key && !get().authManual) {
      set({ authValue: `Bearer ${token}` });
    }
  } catch (err) {
    if (get().environmentKey === key) set({ crafterError: messageOf(err) });
  } finally {
    tokenRequestInFlight = false;
    set({ tokenLoading: false });
  }

  // Clicking quickly through the environment list drops the intermediate
  // fetches, which is what keeps the acquisitions serialised. Catching up once
  // the queue drains stops the field showing a token for the wrong
  // environment, and is still one acquisition at a time.
  const settled = get().environmentKey;
  if (settled !== key && !get().authManual) {
    await fetchToken(set, get, settled);
  }
}

/** Read once at module load; the store then owns the draft. */
const initialDraft = loadDraft();

/**
 * Fold a newly picked operation into the crafter state (ambiguity 22).
 *
 * The environment and the bearer token survive unconditionally — they belong
 * to the session, not to the operation. Typed header and parameter values
 * survive where the new operation still has a matching row, so re-picking the
 * same operation at another accept-version keeps its path parameters and drops
 * query parameters that version lacks. `Accept` is always taken from the new
 * operation.
 *
 * Custom headers and parameters survive only while the resource is the same;
 * an ad-hoc header added for one endpoint rarely means anything on another.
 */
export function applySelection(
  state: Pick<RestStore,
    'selection' | 'headerValues' | 'paramValues' | 'customHeaders' | 'customParams'
    | 'bodyText' | 'bodyEdited' | 'bodySkeletonBaseline'>,
  selection: ApiDocsRestSelection
): Pick<RestStore,
  'selection' | 'headerValues' | 'paramValues' | 'customHeaders' | 'customParams'
  | 'bodyText' | 'bodyEdited' | 'bodySkeletonBaseline'> {
  // Identity ignores the contract version and accept-version: the same
  // endpoint picked from a pre-release is still the same resource. With no
  // previous selection there is nothing to have moved away from — the custom
  // rows came from the restored draft for this very operation.
  const sameResource = state.selection === null
    || (state.selection.serviceName === selection.serviceName
      && state.selection.method === selection.method
      && state.selection.path === selection.path);

  const customHeaders = sameResource ? state.customHeaders : [];
  const customParams = sameResource ? state.customParams : [];

  const headerRows = defaultHeaderRows(selection, customHeaders);
  const paramRows = defaultParamRows(selection, customParams);

  const headerValues = carryOverValues(state.headerValues, headerRows);
  // The old media-type version would otherwise be silently wrong.
  delete headerValues[ACCEPT];

  const keepBody = keepEditedBody(
    state.bodyEdited, state.bodySkeletonBaseline, selection.bodySkeleton
  );

  return {
    selection,
    headerValues,
    paramValues: carryOverValues(state.paramValues, paramRows),
    customHeaders,
    customParams,
    bodyText: keepBody ? state.bodyText : selection.bodySkeleton,
    bodyEdited: keepBody,
    bodySkeletonBaseline: selection.bodySkeleton,
  };
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

  environments: [],
  // Restored without acquiring a token: startup must never authenticate on
  // its own, which would widen the account-lockout surface for nothing.
  environmentKey: initialDraft?.environmentKey ?? DEFAULT_ENVIRONMENT,
  authValue: '',
  authManual: false,
  headerValues: initialDraft?.headerValues ?? {},
  customHeaders: initialDraft?.customHeaders ?? [],
  paramValues: initialDraft?.paramValues ?? {},
  customParams: initialDraft?.customParams ?? [],
  bodyText: initialDraft?.bodyText ?? '',
  bodyEdited: initialDraft?.bodyEdited ?? false,
  bodySkeletonBaseline: initialDraft?.bodySkeletonBaseline ?? '',
  activeTab: 'headers',
  tokenLoading: false,
  sending: false,
  crafterError: null,
  responses: [],
  activeResponseId: null,

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
      set({ ...applySelection(get(), selection), pendingSelection: null, loading: false });
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
        set({ ...applySelection(get(), selection), pendingSelection: null });
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

  // -------------------------------------------------------------------------
  // REST Crafter (R3)
  // -------------------------------------------------------------------------

  loadEnvironments: async () => {
    if (get().environments.length > 0) return;
    try {
      const environments = await window.dad.restEnvironments();
      set({ environments });
    } catch (err) {
      set({ crafterError: messageOf(err) });
    }
  },

  setEnvironment: async (key) => {
    if (get().environmentKey === key) return;
    set({ environmentKey: key, crafterError: null });
    persist(get());
    // A hand-typed token must survive an environment change (6.2.3.1).
    if (get().authManual) return;
    await fetchToken(set, get, key);
  },

  setAuthValue: (value) => set({ authValue: value, authManual: true }),

  resetAuth: async () => {
    // Requirement 6.2.3.1: discard the manual token and go back to the
    // automatic one for the selected environment.
    set({ authManual: false, crafterError: null });
    await fetchToken(set, get, get().environmentKey);
  },

  setHeaderValue: (key, value) => {
    set((s) => ({ headerValues: { ...s.headerValues, [key]: value } }));
    persist(get());
  },

  addCustomHeader: () => {
    set((s) => ({ customHeaders: [...s.customHeaders, { id: newId(), name: '', value: '' }] }));
    persist(get());
  },

  updateCustomHeader: (id, patch) => {
    set((s) => ({
      customHeaders: s.customHeaders.map((h) => (h.id === id ? { ...h, ...patch } : h)),
    }));
    persist(get());
  },

  removeCustomHeader: (id) => {
    set((s) => {
      const { [`custom:${id}`]: _removed, ...headerValues } = s.headerValues;
      return { customHeaders: s.customHeaders.filter((h) => h.id !== id), headerValues };
    });
    persist(get());
  },

  setParamValue: (key, value) => {
    set((s) => ({ paramValues: { ...s.paramValues, [key]: value } }));
    persist(get());
  },

  addCustomParam: () => {
    set((s) => ({ customParams: [...s.customParams, { id: newId(), name: '', value: '' }] }));
    persist(get());
  },

  updateCustomParam: (id, patch) => {
    set((s) => ({
      customParams: s.customParams.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    }));
    persist(get());
  },

  removeCustomParam: (id) => {
    set((s) => {
      const { [`custom:${id}`]: _removed, ...paramValues } = s.paramValues;
      return { customParams: s.customParams.filter((p) => p.id !== id), paramValues };
    });
    persist(get());
  },

  setBodyText: (text, fromUser) => {
    // Only a genuine keystroke marks the body as edited; a programmatic reload
    // of the skeleton must not, or every selection change would look edited.
    set((s) => ({ bodyText: text, bodyEdited: fromUser ? true : s.bodyEdited }));
    persist(get());
  },

  setActiveTab: (tab) => set({ activeTab: tab }),

  send: async () => {
    const state = get();
    // One request in flight per panel (ambiguity 25) — no cancellation.
    if (state.sending || !state.selection) return;

    const paramRows = defaultParamRows(state.selection, state.customParams);
    const missing = missingPathParams(paramRows, state.paramValues);
    if (missing.length > 0) {
      set({
        crafterError:
          `Fill in the path parameter${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`,
      });
      return;
    }

    const headerRows = defaultHeaderRows(state.selection, state.customHeaders);
    const path = craftedPath(state.selection, paramRows, state.paramValues);
    const environment = state.environments.find((e) => e.key === state.environmentKey);
    set({ sending: true, crafterError: null });
    try {
      const result = await window.dad.restSend({
        environmentKey: state.environmentKey,
        method: state.selection.method,
        path,
        headers: requestHeaders(headerRows, state.headerValues, state.authValue),
        body: state.bodyText,
        autoAuth: !state.authManual,
      });
      // Every send opens its own tab (ambiguity 15) so two runs of the same
      // request can be compared side by side.
      get().addResponseTab({
        title: path,
        url: result.url || `${environment?.baseUrl ?? ''}${path}`,
        method: state.selection.method,
        loading: false,
        result,
        origin: 'crafter',
      });
      set({ sending: false });
    } catch (err) {
      set({ sending: false, crafterError: messageOf(err) });
    }
  },

  clearCrafterError: () => set({ crafterError: null }),

  // -------------------------------------------------------------------------
  // REST Response (R4)
  // -------------------------------------------------------------------------

  addResponseTab: (tab) => {
    const id = newId();
    // Appended right and activated (ambiguity 14) — the user asked for this
    // response, so it is what they want to look at.
    set((s) => ({
      responses: [...s.responses, { ...tab, id }],
      activeResponseId: id,
    }));
    return id;
  },

  settleResponseTab: (id, result) => set((s) => ({
    responses: s.responses.map((r) => (
      r.id === id ? { ...r, loading: false, result, url: result.url || r.url } : r
    )),
  })),

  closeResponseTab: (id) => set((s) => {
    const index = s.responses.findIndex((r) => r.id === id);
    if (index === -1) return {};
    const responses = s.responses.filter((r) => r.id !== id);
    if (s.activeResponseId !== id) return { responses };
    // Activate the right-hand neighbour, falling back to the left, so closing
    // never drops to the empty state while tabs remain.
    const next = responses[index] ?? responses[index - 1] ?? null;
    return { responses, activeResponseId: next ? next.id : null };
  }),

  setActiveResponse: (id) => set({ activeResponseId: id }),

  copyLinkToCrafter: (tabId) => {
    const tab = get().responses.find((r) => r.id === tabId);
    if (!tab) return;

    const selection = selectionFromUrl(tab.url);
    const customParams = customParamsFromUrl(tab.url);
    // A link may point outside the selected environment; switch to the one that
    // serves it so the Crafter sends where the link actually pointed.
    const match = get().environments.find((e) => {
      try {
        return new URL(tab.url).host === new URL(e.baseUrl).host;
      } catch {
        return false;
      }
    });

    set((s) => ({
      ...applySelection(s, selection),
      environmentKey: match ? match.key : s.environmentKey,
      customParams,
      // Values live in the row map, keyed the way defaultParamRows builds them.
      paramValues: Object.fromEntries(
        customParams.map((p) => [`custom:${p.id}`, p.value])
      ),
      activeTab: 'headers',
      crafterError: match
        ? null
        : 'This link is outside the selected environment — check the environment before sending.',
    }));
    persist(get());
    saveIdentity(null);
  },

  followLink: async (url) => {
    const { environmentKey, authValue, authManual } = get();
    // The tab opens immediately in a loading state (ambiguity 11) so a slow or
    // failing link is visible rather than silent.
    const id = get().addResponseTab({
      title: pathOfUrl(url),
      url,
      method: 'GET',
      loading: true,
      result: null,
      origin: 'link',
    });
    try {
      const result = await window.dad.restSend({
        environmentKey,
        method: 'GET',
        path: '',
        absoluteUrl: url,
        // `*/*` is the one Accept proven to pass negotiation on a versioned
        // endpoint without knowing the version (ambiguity 10).
        headers: [
          { name: AUTHORIZATION, value: authValue },
          { name: ACCEPT, value: LINK_ACCEPT },
        ],
        body: '',
        autoAuth: !authManual,
      });
      get().settleResponseTab(id, result);
    } catch (err) {
      get().settleResponseTab(id, {
        ok: false, status: 0, statusText: '', headers: [], body: '', truncated: false,
        durationMs: 0, url, method: 'GET', error: messageOf(err),
      });
    }
  },
}));
