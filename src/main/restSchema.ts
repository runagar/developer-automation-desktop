/**
 * Turns a contract's request body schema into an editable JSON skeleton.
 *
 * Contracts hand the body over as a `$ref` into `definitions` (Swagger 2.0) or
 * `components.schemas` (OpenAPI 3). Neither is useful to type into, so the
 * refs are expanded into a concrete object with placeholder leaves.
 */

/** Resolves a local `$ref` string, or returns null if it cannot be followed. */
export type RefResolver = (ref: string) => unknown;

/**
 * Deep enough for the schemas in the catalogue, shallow enough that a cycle
 * expressed without `$ref` cannot hang the main process.
 */
const MAX_DEPTH = 12;

function isObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Merge `allOf` branches left to right.
 *
 * Later branches win on key collisions, and `properties` are merged rather
 * than replaced — an `allOf` that adds two properties in two branches must
 * yield both.
 */
function mergeAllOf(branches: Record<string, any>[]): Record<string, any> {
  const merged: Record<string, any> = {};
  for (const branch of branches) {
    for (const [key, value] of Object.entries(branch)) {
      if (key === 'properties' && isObject(merged.properties) && isObject(value)) {
        merged.properties = { ...merged.properties, ...value };
      } else if (key === 'required' && Array.isArray(merged.required) && Array.isArray(value)) {
        merged.required = [...new Set([...merged.required, ...value])];
      } else {
        merged[key] = value;
      }
    }
  }
  return merged;
}

/** A stand-in value for a leaf whose schema gives no example or default. */
function placeholderFor(schema: Record<string, any>): unknown {
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case 'integer':
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object':
      return {};
    case 'string':
      return '';
    default:
      // No declared type and no composition keyword — an empty string is the
      // least misleading thing to show.
      return '';
  }
}

interface Context {
  resolve: RefResolver;
  /** Refs currently being expanded, so a self-referencing schema terminates. */
  stack: string[];
}

function expand(schema: unknown, ctx: Context, depth: number): unknown {
  if (depth > MAX_DEPTH) return null;
  if (!isObject(schema)) return null;

  if (typeof schema.$ref === 'string') {
    const ref = schema.$ref;
    // Already expanding this ref higher up the tree: recursing would not
    // terminate, so the branch is cut and rendered as null.
    if (ctx.stack.includes(ref)) return null;
    const resolved = ctx.resolve(ref);
    if (!isObject(resolved)) return null;
    ctx.stack.push(ref);
    try {
      return expand(resolved, ctx, depth + 1);
    } finally {
      ctx.stack.pop();
    }
  }

  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    const branches = schema.allOf
      .map((branch: unknown) => {
        if (isObject(branch) && typeof branch.$ref === 'string') {
          if (ctx.stack.includes(branch.$ref)) return null;
          const resolved = ctx.resolve(branch.$ref);
          return isObject(resolved) ? resolved : null;
        }
        return isObject(branch) ? branch : null;
      })
      .filter(isObject);
    const { allOf, ...rest } = schema;
    return expand(mergeAllOf([...branches, rest]), ctx, depth + 1);
  }

  const composed = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(composed) && composed.length > 0) {
    // No way to know which branch the user wants; the first is the convention
    // every other tool of this kind uses.
    return expand(composed[0], ctx, depth + 1);
  }

  // An explicit example or default beats anything DAD could invent.
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];

  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;

  if (type === 'array' || isObject(schema.items)) {
    if (!isObject(schema.items)) return [];
    // One sample element, so the shape is visible and the user can duplicate it.
    return [expand(schema.items, ctx, depth + 1)];
  }

  if (type === 'object' || isObject(schema.properties)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    const out: Record<string, unknown> = {};
    // All properties, not just the required ones — an optional field the user
    // cannot see is a field they will not remember to send.
    for (const [name, propSchema] of Object.entries(properties)) {
      out[name] = expand(propSchema, ctx, depth + 1);
    }
    if (Object.keys(out).length === 0 && isObject(schema.additionalProperties)) {
      return {};
    }
    return out;
  }

  return placeholderFor(schema);
}

/** Expand a schema into a concrete sample value. */
export function buildSkeleton(schema: unknown, resolve: RefResolver): unknown {
  return expand(schema, { resolve, stack: [] }, 0);
}

/**
 * The skeleton as pretty-printed JSON, ready for the Body tab.
 *
 * An operation that declares no body yields an empty string rather than `{}`:
 * `{}` is a real body, and sending one to an endpoint that documents none gets
 * the request rejected. A body that is *declared* but cannot be resolved still
 * gets `{}`, since there the user does need something to type into.
 */
export function skeletonJson(schema: unknown | null, resolve: RefResolver): string {
  if (schema === null || schema === undefined) return '';
  const value = buildSkeleton(schema, resolve);
  if (value === null || value === undefined) return '{}';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    // Circular structure survived expansion — should not happen, but an empty
    // object is better than crashing the contract fetch.
    return '{}';
  }
}
