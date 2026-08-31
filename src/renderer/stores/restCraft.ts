import {
  ApiDocsParameter, ApiDocsRestSelection, RestHeaderSpec,
} from '../../main/types';

/**
 * Pure request-composition helpers for the REST Crafter.
 *
 * Kept out of the store so they can be unit-tested without React or Zustand,
 * and so the URL the panel displays and the request it sends are built by
 * exactly one piece of code.
 */

export const AUTHORIZATION = 'Authorization';
export const ACCEPT = 'Accept';
export const CONTENT_TYPE = 'Content-Type';

export interface CustomHeader {
  id: string;
  name: string;
  value: string;
}

export interface CustomParam {
  id: string;
  name: string;
  value: string;
}

export type HeaderRowKind = 'auth' | 'accept' | 'content-type' | 'contract' | 'custom';

export interface HeaderRow {
  /** Stable identity for React keys and for the value maps. */
  key: string;
  name: string;
  kind: HeaderRowKind;
  /** What the contract documents, shown when the user has typed nothing. */
  defaultValue: string;
  /** Enum values, or `produces` for Accept — rendered as a combobox. */
  options: string[];
  description: string;
  required: boolean;
  removable: boolean;
}

export interface ParamRow {
  key: string;
  name: string;
  location: 'path' | 'query';
  defaultValue: string;
  options: string[];
  description: string;
  required: boolean;
  removable: boolean;
}

function stringOf(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function optionsOf(param: ApiDocsParameter): string[] {
  const raw = (param as any).enum ?? (param as any).schema?.enum;
  if (!Array.isArray(raw)) return [];
  return raw.map(stringOf).filter((v) => v.length > 0);
}

function defaultOf(param: ApiDocsParameter): string {
  const raw = (param as any).default ?? (param as any).schema?.default;
  return stringOf(raw);
}

/** Required parameters first, otherwise declaration order is preserved. */
function requiredFirst<T extends { required: boolean }>(rows: T[]): T[] {
  return [
    ...rows.filter((r) => r.required),
    ...rows.filter((r) => !r.required),
  ];
}

/** True when the operation takes a request body at all. */
export function takesBody(selection: ApiDocsRestSelection | null): boolean {
  return selection?.requestBodySchema !== null && selection?.requestBodySchema !== undefined;
}

/**
 * The header rows, in the order of ambiguity 16.
 *
 * `Accept` appears once even though contracts also declare it as an explicit
 * header parameter, and is pre-filled from the operation's media type rather
 * than from that parameter's (empty) default.
 */
export function defaultHeaderRows(
  selection: ApiDocsRestSelection | null,
  customHeaders: CustomHeader[]
): HeaderRow[] {
  const rows: HeaderRow[] = [{
    key: AUTHORIZATION,
    name: AUTHORIZATION,
    kind: 'auth',
    defaultValue: '',
    options: [],
    description: 'Bearer token for the selected environment',
    required: false,
    removable: false,
  }];

  if (selection) {
    const acceptParam = selection.parameters.find(
      (p) => p.in === 'header' && p.name.toLowerCase() === 'accept'
    );
    rows.push({
      key: ACCEPT,
      name: ACCEPT,
      kind: 'accept',
      defaultValue: selection.acceptHeader ?? '',
      // Several `produces` entries become the dropdown of ambiguity 12; the
      // field stays editable regardless, per requirement 6.2.2.
      options: selection.produces.length > 1 ? selection.produces : [],
      description: acceptParam?.description ?? '',
      required: true,
      removable: false,
    });

    // `Consumes` is not a header — the real one is Content-Type, and it only
    // makes sense for an operation that carries a body.
    if (takesBody(selection)) {
      rows.push({
        key: CONTENT_TYPE,
        name: CONTENT_TYPE,
        kind: 'content-type',
        defaultValue: selection.consumesHeader ?? 'application/json',
        options: selection.consumes.length > 1 ? selection.consumes : [],
        description: '',
        required: false,
        removable: false,
      });
    }

    const contractRows = selection.parameters
      .filter((p) => p.in === 'header')
      .filter((p) => !['accept', 'authorization', 'content-type'].includes(p.name.toLowerCase()))
      .map((p): HeaderRow => ({
        key: p.name,
        name: p.name,
        kind: 'contract',
        defaultValue: defaultOf(p),
        options: optionsOf(p),
        description: p.description ?? '',
        required: p.required === true,
        removable: false,
      }));
    rows.push(...requiredFirst(contractRows));
  }

  rows.push(...customHeaders.map((h): HeaderRow => ({
    key: `custom:${h.id}`,
    name: h.name,
    kind: 'custom',
    defaultValue: '',
    options: [],
    description: '',
    required: false,
    removable: true,
  })));

  return rows;
}

/** Path and query parameters only — headers and the body have their own tabs. */
export function defaultParamRows(
  selection: ApiDocsRestSelection | null,
  customParams: CustomParam[]
): ParamRow[] {
  const rows: ParamRow[] = [];
  if (selection) {
    const relevant = selection.parameters
      .filter((p) => p.in === 'path' || p.in === 'query')
      .map((p): ParamRow => ({
        key: `${p.in}:${p.name}`,
        name: p.name,
        location: p.in as 'path' | 'query',
        defaultValue: defaultOf(p),
        options: optionsOf(p),
        description: p.description ?? '',
        // Swagger requires path parameters to be required, but not every
        // contract says so; the URL is structurally invalid without them.
        required: p.in === 'path' || p.required === true,
        removable: false,
      }));
    // Path parameters first — they are the ones that block a send.
    rows.push(...relevant.filter((r) => r.location === 'path'));
    rows.push(...requiredFirst(relevant.filter((r) => r.location === 'query')));
  }

  rows.push(...customParams.map((p): ParamRow => ({
    key: `custom:${p.id}`,
    name: p.name,
    location: 'query',
    defaultValue: '',
    options: [],
    description: '',
    required: false,
    removable: true,
  })));

  return rows;
}

/** What a row will actually send: the user's input, else the documented default. */
export function effectiveValue(
  row: { key: string; defaultValue: string },
  values: Record<string, string>
): string {
  const typed = values[row.key];
  return typed !== undefined ? typed : row.defaultValue;
}

const PATH_PLACEHOLDER_RE = /\{([^{}]+)\}/g;

/**
 * Substitute filled path parameters into the path.
 *
 * Unfilled placeholders are left as `{name}` so the URL always reads as
 * exactly what would be sent (ambiguity 3).
 */
export function substitutePath(
  fullPath: string,
  rows: ParamRow[],
  values: Record<string, string>
): string {
  return fullPath.replace(PATH_PLACEHOLDER_RE, (match, rawName: string) => {
    const row = rows.find((r) => r.location === 'path' && r.name === rawName);
    const value = row ? effectiveValue(row, values).trim() : '';
    return value.length > 0 ? encodeURIComponent(value) : match;
  });
}

/** The query string for the filled query parameters, or '' when there are none. */
export function buildQuery(rows: ParamRow[], values: Record<string, string>): string {
  const parts: string[] = [];
  for (const row of rows) {
    if (row.location !== 'query') continue;
    if (row.name.trim().length === 0) continue;
    const value = effectiveValue(row, values).trim();
    if (value.length === 0) continue;
    parts.push(`${encodeURIComponent(row.name.trim())}=${encodeURIComponent(value)}`);
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

/** The path plus query exactly as it will be sent. */
export function craftedPath(
  selection: ApiDocsRestSelection | null,
  rows: ParamRow[],
  values: Record<string, string>
): string {
  if (!selection) return '';
  return `${substitutePath(selection.fullPath, rows, values)}${buildQuery(rows, values)}`;
}

/**
 * Path parameters with no value.
 *
 * These block a send (ambiguity 4) because the URL is structurally invalid
 * without them; missing query parameters are deliberately allowed through.
 */
export function missingPathParams(rows: ParamRow[], values: Record<string, string>): string[] {
  return rows
    .filter((r) => r.location === 'path')
    .filter((r) => effectiveValue(r, values).trim().length === 0)
    .map((r) => r.name);
}

/** The headers to send, before empty ones are dropped in the main process. */
export function requestHeaders(
  rows: HeaderRow[],
  values: Record<string, string>,
  authValue: string
): RestHeaderSpec[] {
  return rows.map((row) => ({
    name: row.name,
    value: row.kind === 'auth' ? authValue : effectiveValue(row, values),
  }));
}

/**
 * Which user-entered values survive a change of selection (ambiguity 22).
 *
 * Values are kept when the new operation still has a row of the same key, and
 * dropped otherwise — so re-picking the same operation at another version
 * keeps the path parameters and loses query parameters that version does not
 * have. Accept is always taken from the new operation.
 */
export function carryOverValues(
  previous: Record<string, string>,
  rows: Array<{ key: string }>
): Record<string, string> {
  const allowed = new Set(rows.map((r) => r.key));
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(previous)) {
    if (allowed.has(key)) out[key] = value;
  }
  return out;
}

/**
 * Whether a hand-edited body still belongs to the newly selected operation.
 *
 * Comparing the skeletons rather than the operation identity is what lets the
 * same body survive a switch between, say, a release and a pre-release that
 * declare an identical schema.
 */
export function keepEditedBody(
  bodyEdited: boolean, previousSkeleton: string, nextSkeleton: string
): boolean {
  return bodyEdited && previousSkeleton === nextSkeleton;
}
