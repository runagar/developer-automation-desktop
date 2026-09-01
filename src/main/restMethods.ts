/**
 * HTTP method rules — pure helpers shared by the main process and the renderer.
 *
 * This module must stay free of `fs`, `path` and `electron` imports so the
 * renderer can import it directly (same constraint as workspaceKeys.ts).
 */

/**
 * Methods whose body `fetch` refuses to send.
 *
 * Passing a body with one of these throws in Undici rather than being ignored,
 * so the body has to be dropped before the request is built.
 */
export const BODYLESS_METHODS = ['GET', 'HEAD'];

/** True when a request with this method may carry a body at all. */
export function sendsBody(method: string): boolean {
  return !BODYLESS_METHODS.includes(method.toUpperCase());
}
