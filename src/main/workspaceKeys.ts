/**
 * Workspace key rules — pure helpers shared by the main process and the renderer.
 *
 * This module must stay free of `fs`, `path` and `electron` imports so the
 * renderer can import it directly (same constraint as archivePolicy.ts).
 */

export const KEY_MAX_LENGTH = 8;

const SEPARATORS = /[-_. ]+/;
const FALLBACK_KEY = 'WS';

/** Human-readable description of the key format, for error messages and tooltips. */
export const KEY_FORMAT_HINT = `1-${KEY_MAX_LENGTH} characters: A-Z, 0-9, - and _`;

/** Uppercase, strip everything outside A-Z0-9-_, and clamp to KEY_MAX_LENGTH. */
export function normalizeKey(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, KEY_MAX_LENGTH);
}

export function isValidKey(key: string): boolean {
  // Must normalize to itself and contain at least one alphanumeric character,
  // so a key of pure punctuation (e.g. "--") is rejected.
  return key.length > 0 && normalizeKey(key) === key && /[A-Z0-9]/.test(key);
}

/**
 * Derive a default key from a repository/directory name.
 * Multi-part names use the initial of each part; single-part names use the
 * first three characters.
 */
export function abbreviateRepo(repo: string): string {
  // Normalize each part first so leading punctuation (e.g. "@scope-tag")
  // doesn't swallow the initial we want.
  const parts = repo.split(SEPARATORS).map(normalizeKey).filter(Boolean);
  const raw = parts.length >= 2
    ? parts.map((p) => p[0]).join('')
    : (parts[0] ?? '').slice(0, 3);
  return normalizeKey(raw) || FALLBACK_KEY;
}

/**
 * Return `base` if free, otherwise append a counter (RCR → RCR2 → RCR3 …).
 * The base is truncated rather than the suffix so the counter is never lost.
 */
export function uniqueKey(base: string, taken: Set<string>): string {
  const seed = normalizeKey(base) || FALLBACK_KEY;
  if (!taken.has(seed)) return seed;

  for (let n = 2; ; n++) {
    const suffix = String(n);
    const stem = seed.slice(0, Math.max(1, KEY_MAX_LENGTH - suffix.length));
    const candidate = `${stem}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}
