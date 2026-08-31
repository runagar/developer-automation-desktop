import {
  TokenTarget, withToken, AuthConfigurationError, AuthUnavailableError,
} from './nykAuth';
import { skeletonJson } from './restSchema';

// ---------------------------------------------------------------------------
// Runtime configuration
//
// api-docs publishes its own endpoints and OAuth client id in a public
// config.json. Reading it at runtime is what the official client does, so DAD
// keeps working if the platform moves without needing a release.
// ---------------------------------------------------------------------------

const CONFIG_URL = 'https://apidocs.nykredit.it/config.json';
const REQUEST_TIMEOUT_MS = 20_000;

/** Values as published on 2026-08-28, used only if config.json is unreachable. */
const FALLBACK_CONFIG = {
  apiBase: 'https://infrastructure.services.nykredit.dk/api-docs',
  clientId: '4afcc127-3297-4e37-8cfc-446ffbce54b2',
  securityHost: 'security.services.nykredit.dk',
  redirectUri: 'https://apidocs.nykredit.it/cb.html',
};

export interface ApiDocsConfig {
  apiBase: string;
  clientId: string;
  securityHost: string;
  redirectUri: string;
}

let cachedConfig: ApiDocsConfig | null = null;

export function parseApiDocsConfig(raw: Record<string, unknown>): ApiDocsConfig {
  const str = (key: string): string | null =>
    typeof raw[key] === 'string' && (raw[key] as string).length > 0 ? (raw[key] as string) : null;

  const apiBase = str('endpoint.api-docs') ?? FALLBACK_CONFIG.apiBase;
  const clientId = str('oauth.clientid') ?? FALLBACK_CONFIG.clientId;

  let securityHost = FALLBACK_CONFIG.securityHost;
  const oauthEndpoint = str('oauth.endpoint');
  if (oauthEndpoint) {
    try {
      securityHost = new URL(oauthEndpoint).hostname;
    } catch {
      // Malformed URL in config — keep the fallback host.
    }
  }

  let redirectUri = FALLBACK_CONFIG.redirectUri;
  const publicUri = str('public.uri');
  const redirectPath = str('oauth.redirect');
  if (publicUri && redirectPath) {
    redirectUri = `${publicUri.replace(/\/$/, '')}${redirectPath.startsWith('/') ? '' : '/'}${redirectPath}`;
  }

  return { apiBase: apiBase.replace(/\/$/, ''), clientId, securityHost, redirectUri };
}

export async function loadConfig(): Promise<ApiDocsConfig> {
  if (cachedConfig) return cachedConfig;
  try {
    const response = await fetch(CONFIG_URL, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (response.ok) {
      cachedConfig = parseApiDocsConfig(await response.json() as Record<string, unknown>);
      return cachedConfig;
    }
  } catch {
    // Unreachable (off VPN, DNS failure) — the hardcoded values are still
    // correct as of the last verification, so the picker can keep working.
  }
  cachedConfig = { ...FALLBACK_CONFIG };
  return cachedConfig;
}

function tokenTarget(config: ApiDocsConfig): TokenTarget {
  return {
    securityHost: config.securityHost,
    clientId: config.clientId,
    redirectUri: config.redirectUri,
  };
}

export async function apiDocsTarget(): Promise<TokenTarget> {
  return tokenTarget(await loadConfig());
}

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type ContractType = 'RELEASE' | 'PRERELEASE' | 'BRANCH';

export interface ContractVersion {
  name: string;
  type: ContractType;
  modifiedTs: string;
  /** HAL link straight to the contract, preferred over a constructed URL. */
  href: string | null;
}

export interface ServiceVersions {
  releases: ContractVersion[];
  prereleases: ContractVersion[];
  branches: ContractVersion[];
}

export interface SwaggerParameter {
  name: string;
  in: string;
  required?: boolean;
  type?: string;
  description?: string;
  schema?: unknown;
  [key: string]: unknown;
}

/** One accept-version of an operation. */
export interface OperationVariant {
  acceptVersion: string | null;
  deprecated: boolean;
  summary: string;
  tags: string[];
  operationId: string | null;
  produces: string[];
  consumes: string[];
  parameters: SwaggerParameter[];
  /**
   * The raw request body schema, kept here so `buildSelection` need not
   * re-derive it from a `body` parameter that OpenAPI 3 does not have.
   */
  bodySchema: unknown | null;
  /** The original `paths` key, retained for exact re-lookup. */
  pathKey: string;
}

/** An operation grouped across its accept-versions. */
export interface OperationRow {
  method: string;
  path: string;
  summary: string;
  deprecated: boolean;
  /** Swagger tag the operation is grouped under; `UNTAGGED` when it declares none. */
  tag: string;
  variants: OperationVariant[];
}

export const UNTAGGED = 'UNTAGGED';

/** What the API Picker hands to the REST Crafter. */
export interface RestSelection {
  serviceName: string;
  category: string;
  contractType: ContractType;
  contractVersion: string;
  method: string;
  path: string;
  fullPath: string;
  acceptVersion: string | null;
  acceptHeader: string | null;
  /** Every media type the operation can return — the Accept dropdown. */
  produces: string[];
  consumesVersion: string | null;
  consumesHeader: string | null;
  /** Every media type the operation accepts — the Content-Type dropdown. */
  consumes: string[];
  requestBodySchema: unknown | null;
  /** The request body with every `$ref` expanded, pretty-printed. */
  bodySkeleton: string;
  parameters: SwaggerParameter[];
  deprecated: boolean;
  summary: string;
}

// ---------------------------------------------------------------------------
// Caches (in-memory, main process only — nothing is written to disk)
// ---------------------------------------------------------------------------

const CONTRACT_CACHE_LIMIT = 20;

let servicesCache: string[] | null = null;
const versionsCache = new Map<string, ServiceVersions>();
const contractCache = new Map<string, any>();

export function clearCaches(): void {
  servicesCache = null;
  versionsCache.clear();
  contractCache.clear();
}

function cacheContract(key: string, contract: any): void {
  if (contractCache.size >= CONTRACT_CACHE_LIMIT) {
    const oldest = contractCache.keys().next().value;
    if (oldest !== undefined) contractCache.delete(oldest);
  }
  contractCache.set(key, contract);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function apiGet<T>(dataDir: string, url: string, accept: string): Promise<T> {
  const target = await apiDocsTarget();
  return withToken<T>(
    dataDir,
    target,
    (token) => fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: accept },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }),
    (response) => response.json() as Promise<T>
  );
}

/** Wraps a network-level failure so the renderer can tell it from a rejection. */
async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err: any) {
    if (err instanceof AuthConfigurationError) throw err;
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || err?.name === 'TypeError') {
      throw new AuthUnavailableError('Could not reach API-docs — are you on the corporate network?');
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Alphabetical, numeric-aware, case-insensitive — requirement 2.1.2. */
export function sortServiceNames(names: string[]): string[] {
  return [...names].sort((a, b) => collator.compare(a, b));
}

/**
 * Every service in the `default` category.
 *
 * Other categories are excluded per requirement 2.1.1, which also removes the
 * duplicate-name problem: a service may appear under several categories, but
 * `default` names are unique.
 */
export async function listServices(dataDir: string): Promise<string[]> {
  if (servicesCache) return servicesCache;
  const config = await loadConfig();
  const data = await guarded(() =>
    apiGet<{ services?: Array<{ name?: string; category?: string }> }>(
      // This endpoint is HAL and answers 406 to `application/json`.
      dataDir, `${config.apiBase}/services`, 'application/hal+json'
    )
  );
  const names = (data.services ?? [])
    .filter((s) => s.category === 'default' && typeof s.name === 'string')
    .map((s) => s.name as string);
  servicesCache = sortServiceNames(names);
  return servicesCache;
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

function mapVersions(entries: any[], type: ContractType): ContractVersion[] {
  return (entries ?? [])
    .filter((e) => typeof e?.name === 'string')
    .map((e) => ({
      name: e.name as string,
      type,
      modifiedTs: typeof e.modifiedTs === 'string' ? e.modifiedTs : '',
      href: typeof e?._links?.documentation?.href === 'string' ? e._links.documentation.href : null,
    }));
}

export async function listVersions(dataDir: string, service: string): Promise<ServiceVersions> {
  const cached = versionsCache.get(service);
  if (cached) return cached;

  const config = await loadConfig();
  const url = `${config.apiBase}/services/${encodeURIComponent(service)}/categories/default`;
  // The official client sends a millisecond cache-buster on this call.
  const data = await guarded(() =>
    apiGet<any>(dataDir, url, `application/hal+json;t=${Date.now()}`)
  );
  const embedded = data?._embedded ?? {};
  const versions: ServiceVersions = {
    releases: mapVersions(embedded.releases, 'RELEASE'),
    prereleases: mapVersions(embedded.prereleases, 'PRERELEASE'),
    branches: mapVersions(embedded.branches, 'BRANCH'),
  };
  versionsCache.set(service, versions);
  return versions;
}

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

export function typeSegment(type: ContractType): string {
  switch (type) {
    case 'RELEASE': return 'releases';
    case 'PRERELEASE': return 'prereleases';
    case 'BRANCH': return 'branches';
  }
}

function contractKey(service: string, type: ContractType, version: string): string {
  return `${service}|${type}|${version}`;
}

/**
 * Prefer the HAL link the API gave us, but only after confirming it points at
 * the configured API base over the same scheme — a downgraded or hostile link
 * must never receive DAD's bearer token.
 */
function safeHref(href: string | null, apiBase: string): string | null {
  if (!href) return null;
  try {
    const link = new URL(href);
    const base = new URL(apiBase);
    if (link.hostname !== base.hostname) return null;
    if (link.protocol !== base.protocol) return null;
    if (!link.pathname.startsWith(new URL(apiBase).pathname)) return null;
    return href;
  } catch {
    return null;
  }
}

export async function getContract(
  dataDir: string, service: string, type: ContractType, version: string
): Promise<any> {
  const key = contractKey(service, type, version);
  const cached = contractCache.get(key);
  if (cached) return cached;

  const config = await loadConfig();
  let url = `${config.apiBase}/services/${encodeURIComponent(service)}`
    + `/categories/default/${typeSegment(type)}/${encodeURIComponent(version)}`;

  const known = versionsCache.get(service);
  if (known) {
    const all = [...known.releases, ...known.prereleases, ...known.branches];
    const match = all.find((v) => v.type === type && v.name === version);
    const href = safeHref(match?.href ?? null, config.apiBase);
    if (href) url = href;
  }

  // The server transcodes to JSON even for contracts stored as YAML, so DAD
  // needs no YAML parser.
  const contract = await guarded(() => apiGet<any>(dataDir, url, 'application/json'));
  cacheContract(key, contract);
  return contract;
}

/**
 * Serves the schema map by contract identity, refetching if the cache evicted it.
 *
 * Swagger 2.0 keeps schemas under `definitions`, OpenAPI 3 under
 * `components.schemas`.
 */
export async function getDefinitions(
  dataDir: string, service: string, type: ContractType, version: string
): Promise<Record<string, unknown>> {
  const contract = await getContract(dataDir, service, type, version);
  return contract?.definitions ?? contract?.components?.schemas ?? {};
}

// ---------------------------------------------------------------------------
// Spec-version normalisation
//
// Roughly a third of the catalogue is OpenAPI 3.x rather than Swagger 2.0. The
// two disagree about where the path prefix, the request body, the media types
// and the shared parameters live, so everything that reads those goes through
// the helpers below.
// ---------------------------------------------------------------------------

export type SpecKind = 'swagger2' | 'openapi3';

export function specKind(contract: any): SpecKind {
  return typeof contract?.openapi === 'string' ? 'openapi3' : 'swagger2';
}

/**
 * The path prefix every operation sits under.
 *
 * OpenAPI 3 replaces `basePath` with `servers`, which is a list of whole
 * deployment URLs and only sometimes carries a prefix — `it-org` starts with
 * `http://localhost:9080` and `tapas-service` with `/`, while the prefix for
 * `currency-exchange-rates` is on its first entry. Taking `servers[0]` blindly
 * would therefore drop the prefix for whichever service happens to list a
 * bare host first, so the first *meaningful* pathname wins instead.
 */
export function contractPrefix(contract: any): string {
  if (specKind(contract) === 'swagger2') return typeof contract?.basePath === 'string' ? contract.basePath : '';

  const servers = Array.isArray(contract?.servers) ? contract.servers : [];
  for (const server of servers) {
    const url = server?.url;
    if (typeof url !== 'string' || url.length === 0) continue;
    let pathname: string;
    try {
      // `servers` entries may be relative (`/`), which `new URL` rejects
      // without a base.
      pathname = new URL(url, 'https://placeholder.invalid').pathname;
    } catch {
      continue;
    }
    const trimmed = pathname.replace(/\/+$/, '');
    if (trimmed.length > 0) return trimmed;
  }
  return '';
}

/**
 * Resolve a local `$ref` against the contract.
 *
 * Returns null for external refs and unresolvable pointers so callers degrade
 * to "no extra information" rather than throwing on a malformed contract.
 */
export function resolveLocalRef(contract: any, ref: unknown): any {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  let node: any = contract;
  for (const rawSegment of ref.slice(2).split('/')) {
    if (node === null || typeof node !== 'object') return null;
    // JSON Pointer escaping: ~1 is "/", ~0 is "~".
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    node = node[segment];
  }
  return node ?? null;
}

/**
 * Expand `$ref` parameter entries and drop anything still unusable.
 *
 * Must run before `mergeParameters`, which de-duplicates on name + `in` —
 * neither of which a `$ref` entry has, so merging first would let a path-level
 * and an operation-level reference to the same parameter both survive.
 */
export function normalizeParameters(contract: any, params: unknown): SwaggerParameter[] {
  if (!Array.isArray(params)) return [];
  const out: SwaggerParameter[] = [];
  for (const entry of params) {
    if (!entry || typeof entry !== 'object') continue;
    const resolved = typeof (entry as any).$ref === 'string'
      ? resolveLocalRef(contract, (entry as any).$ref)
      : entry;
    if (!resolved || typeof resolved !== 'object') continue;
    if (typeof resolved.name !== 'string' || typeof resolved.in !== 'string') continue;
    out.push(resolved as SwaggerParameter);
  }
  return out;
}

const JSON_MEDIA_RE = /^application\/(?:[\w.+-]+\+)?json\b/i;

function sortJsonFirst(mediaTypes: string[]): string[] {
  const json = mediaTypes.filter((m) => JSON_MEDIA_RE.test(m));
  return [...json, ...mediaTypes.filter((m) => !json.includes(m))];
}

/**
 * The media types an operation can return — the `Accept` candidates.
 *
 * OpenAPI 3 has no `produces`; the equivalent is the content map of the
 * successful responses, which does carry the `;v=N` parameter DAD needs.
 */
export function operationProduces(contract: any, op: any): string[] {
  if (specKind(contract) === 'swagger2') {
    if (Array.isArray(op?.produces)) return op.produces;
    return Array.isArray(contract?.produces) ? contract.produces : [];
  }

  const responses = op?.responses ?? {};
  const successCodes = Object.keys(responses)
    .filter((code) => /^2\d\d$/.test(code))
    .sort();
  const seen: string[] = [];
  for (const code of successCodes) {
    const content = responses[code]?.content;
    if (!content || typeof content !== 'object') continue;
    for (const mediaType of Object.keys(content)) {
      if (!seen.includes(mediaType)) seen.push(mediaType);
    }
  }
  return seen;
}

/** The media types an operation accepts — the `Content-Type` candidates. */
export function operationConsumes(contract: any, op: any): string[] {
  if (specKind(contract) === 'swagger2') {
    if (Array.isArray(op?.consumes)) return op.consumes;
    return Array.isArray(contract?.consumes) ? contract.consumes : [];
  }

  const content = op?.requestBody?.content;
  if (!content || typeof content !== 'object') return [];
  return sortJsonFirst(Object.keys(content));
}

/**
 * The request body schema, still holding its raw `$ref`.
 *
 * Swagger 2.0 models the body as a parameter; OpenAPI 3 gives it its own
 * `requestBody` keyed by media type.
 */
export function operationBodySchema(
  contract: any, op: any, params: SwaggerParameter[]
): unknown | null {
  if (specKind(contract) === 'swagger2') {
    return params.find((p) => p.in === 'body')?.schema ?? null;
  }

  const content = op?.requestBody?.content;
  if (!content || typeof content !== 'object') return null;
  const preferred = sortJsonFirst(Object.keys(content))[0];
  if (!preferred) return null;
  return content[preferred]?.schema ?? null;
}

// ---------------------------------------------------------------------------
// Operation parsing
// ---------------------------------------------------------------------------

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'] as const;

/** Only the terminal `#v=N` convention is a version marker. */
const VERSION_FRAGMENT_RE = /#v=(\d+)$/;

export function splitPathKey(key: string): { path: string; acceptVersion: string | null } {
  const match = VERSION_FRAGMENT_RE.exec(key);
  if (!match) return { path: key, acceptVersion: null };
  return { path: key.slice(0, match.index), acceptVersion: match[1] };
}

/**
 * Merge path-level parameters with an operation's own.
 *
 * Swagger 2.0 allows parameters shared by every operation on a path; dropping
 * them would silently omit required path or header parameters.
 */
export function mergeParameters(
  pathLevel: SwaggerParameter[] = [], operationLevel: SwaggerParameter[] = []
): SwaggerParameter[] {
  const merged = [...pathLevel];
  for (const param of operationLevel) {
    const idx = merged.findIndex((p) => p.name === param.name && p.in === param.in);
    if (idx >= 0) merged[idx] = param;
    else merged.push(param);
  }
  return merged;
}

function versionRank(v: string | null): number {
  return v === null ? -1 : Number(v);
}

/**
 * Group a contract's paths into operations, collapsing the `#v=N` accept-version
 * variants of the same endpoint onto one row.
 */
export function parseOperations(contract: any): OperationRow[] {
  const paths = contract?.paths ?? {};
  const grouped = new Map<string, OperationRow>();

  for (const pathKey of Object.keys(paths)) {
    const pathItem = paths[pathKey];
    if (!pathItem || typeof pathItem !== 'object') continue;

    const { path, acceptVersion } = splitPathKey(pathKey);
    const pathParams = normalizeParameters(contract, pathItem.parameters);

    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op || typeof op !== 'object') continue;

      const parameters = mergeParameters(
        pathParams, normalizeParameters(contract, op.parameters)
      );

      const variant: OperationVariant = {
        acceptVersion,
        deprecated: op.deprecated === true,
        summary: typeof op.summary === 'string' ? op.summary : '',
        tags: Array.isArray(op.tags) ? op.tags.filter((t: unknown) => typeof t === 'string') : [],
        operationId: typeof op.operationId === 'string' ? op.operationId : null,
        produces: operationProduces(contract, op),
        consumes: operationConsumes(contract, op),
        parameters,
        bodySchema: operationBodySchema(contract, op, parameters),
        pathKey,
      };

      const rowKey = `${method.toUpperCase()} ${path}`;
      const existing = grouped.get(rowKey);
      if (existing) {
        existing.variants.push(variant);
      } else {
        grouped.set(rowKey, {
          method: method.toUpperCase(),
          path,
          summary: variant.summary,
          deprecated: false,
          tag: variant.tags[0] ?? UNTAGGED,
          variants: [variant],
        });
      }
    }
  }

  const rows = [...grouped.values()];
  for (const row of rows) {
    row.variants.sort((a, b) => versionRank(b.acceptVersion) - versionRank(a.acceptVersion));
    // The row represents the newest version, so that is what decides whether
    // the whole operation reads as deprecated.
    row.deprecated = row.variants[0].deprecated;
    row.summary = row.variants[0].summary;
    row.tag = row.variants[0].tags[0] ?? row.tag;
  }

  // Order tags the way the contract declares them, with anything undeclared
  // after, so the picker reads in the same order as the published documentation.
  const declared: string[] = Array.isArray(contract?.tags)
    ? contract.tags.map((t: any) => t?.name).filter((n: unknown): n is string => typeof n === 'string')
    : [];
  const tagRank = (tag: string): number => {
    const idx = declared.indexOf(tag);
    if (idx !== -1) return idx;
    return tag === UNTAGGED ? Number.MAX_SAFE_INTEGER : declared.length;
  };

  rows.sort((a, b) =>
    tagRank(a.tag) - tagRank(b.tag)
    || a.tag.localeCompare(b.tag)
    || a.path.localeCompare(b.path)
    || a.method.localeCompare(b.method));
  return rows;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/** Join a contract `basePath` with a resource path without doubling separators. */
export function joinPath(basePath: string | undefined | null, resourcePath: string): string {
  const base = (basePath ?? '/').replace(/\/+$/, '');
  const resource = resourcePath.startsWith('/') ? resourcePath : `/${resourcePath}`;
  return `${base}${resource}` || '/';
}

/** Pull the `;v=N` marker out of a media type such as `application/json;v=4`. */
export function mediaTypeVersion(mediaType: string | null): string | null {
  if (!mediaType) return null;
  const match = /;\s*v=(\d+)/.exec(mediaType);
  return match ? match[1] : null;
}

export async function buildSelection(
  dataDir: string,
  service: string,
  type: ContractType,
  version: string,
  method: string,
  path: string,
  acceptVersion: string | null
): Promise<RestSelection | null> {
  const contract = await getContract(dataDir, service, type, version);
  const rows = parseOperations(contract);
  const row = rows.find((r) => r.method === method && r.path === path);
  if (!row) return null;

  const variant = row.variants.find((v) => v.acceptVersion === acceptVersion) ?? row.variants[0];
  const acceptHeader = variant.produces[0] ?? null;
  const consumesHeader = variant.consumes[0] ?? null;

  return {
    serviceName: service,
    category: 'default',
    contractType: type,
    contractVersion: version,
    method: row.method,
    path: row.path,
    fullPath: joinPath(contractPrefix(contract), row.path),
    acceptVersion: variant.acceptVersion,
    acceptHeader,
    produces: variant.produces,
    consumesVersion: mediaTypeVersion(consumesHeader),
    consumesHeader,
    consumes: variant.consumes,
    // Kept raw so the R2 handover contract still holds; `bodySkeleton` below is
    // the resolved form the crafter actually edits.
    requestBodySchema: variant.bodySchema,
    bodySkeleton: skeletonJson(
      variant.bodySchema, (ref) => resolveLocalRef(contract, ref)
    ),
    // The body belongs to the Body tab, not the Parameters tab.
    parameters: variant.parameters.filter((p) => p.in !== 'body'),
    deprecated: variant.deprecated,
    summary: variant.summary,
  };
}

export async function listOperations(
  dataDir: string, service: string, type: ContractType, version: string
): Promise<OperationRow[]> {
  return parseOperations(await getContract(dataDir, service, type, version));
}
