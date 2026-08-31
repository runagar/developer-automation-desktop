import { describe, it, expect } from 'vitest';
import { buildSkeleton, skeletonJson } from './restSchema';

/** Resolver over a Swagger 2.0 style definitions map. */
function definitionsResolver(definitions: Record<string, unknown>) {
  return (ref: string): unknown => {
    const match = /^#\/(?:definitions|components\/schemas)\/(.+)$/.exec(ref);
    return match ? definitions[match[1]] ?? null : null;
  };
}

const noRefs = () => null;

describe('buildSkeleton leaf values', () => {
  it('prefers an example over everything else', () => {
    expect(buildSkeleton({ type: 'string', example: 'DKK', default: 'EUR', enum: ['SEK'] }, noRefs))
      .toBe('DKK');
  });

  it('falls back to default, then to the first enum value', () => {
    expect(buildSkeleton({ type: 'string', default: 'EUR', enum: ['SEK'] }, noRefs)).toBe('EUR');
    expect(buildSkeleton({ type: 'string', enum: ['SEK', 'NOK'] }, noRefs)).toBe('SEK');
  });

  it('uses a type placeholder when the schema offers nothing', () => {
    expect(buildSkeleton({ type: 'string' }, noRefs)).toBe('');
    expect(buildSkeleton({ type: 'integer' }, noRefs)).toBe(0);
    expect(buildSkeleton({ type: 'number' }, noRefs)).toBe(0);
    expect(buildSkeleton({ type: 'boolean' }, noRefs)).toBe(false);
  });

  it('treats an untyped leaf as a string placeholder', () => {
    expect(buildSkeleton({ description: 'anything' }, noRefs)).toBe('');
  });

  it('honours a false default rather than skipping it as falsy', () => {
    expect(buildSkeleton({ type: 'boolean', default: false }, noRefs)).toBe(false);
  });

  it('honours a zero example rather than skipping it as falsy', () => {
    expect(buildSkeleton({ type: 'integer', example: 0 }, noRefs)).toBe(0);
  });
});

describe('buildSkeleton objects', () => {
  it('emits every property, not only the required ones', () => {
    const schema = {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' }, note: { type: 'string' } },
    };
    expect(buildSkeleton(schema, noRefs)).toEqual({ id: '', note: '' });
  });

  it('infers an object from properties alone, with no declared type', () => {
    expect(buildSkeleton({ properties: { a: { type: 'integer' } } }, noRefs)).toEqual({ a: 0 });
  });

  it('returns an empty object for a free-form map', () => {
    expect(buildSkeleton({ type: 'object', additionalProperties: { type: 'string' } }, noRefs))
      .toEqual({});
  });
});

describe('buildSkeleton arrays', () => {
  it('emits exactly one sample element', () => {
    const schema = { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } };
    expect(buildSkeleton(schema, noRefs)).toEqual([{ id: '' }]);
  });

  it('emits an empty array when items is missing', () => {
    expect(buildSkeleton({ type: 'array' }, noRefs)).toEqual([]);
  });
});

describe('buildSkeleton $ref resolution', () => {
  const definitions = {
    ConsentRequest: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['MOVE', 'ANNUL'] },
        loans: { type: 'array', items: { $ref: '#/definitions/Loan' } },
      },
    },
    Loan: { type: 'object', properties: { id: { type: 'string' }, amount: { type: 'number' } } },
  };

  it('expands a top-level ref and its nested refs', () => {
    const resolve = definitionsResolver(definitions);
    expect(buildSkeleton({ $ref: '#/definitions/ConsentRequest' }, resolve))
      .toEqual({ type: 'MOVE', loans: [{ id: '', amount: 0 }] });
  });

  it('resolves an OpenAPI 3 components pointer through the same resolver', () => {
    const resolve = definitionsResolver({ Rate: { type: 'object', properties: { code: { type: 'string' } } } });
    expect(buildSkeleton({ $ref: '#/components/schemas/Rate' }, resolve)).toEqual({ code: '' });
  });

  it('yields null for a ref that cannot be resolved', () => {
    expect(buildSkeleton({ $ref: '#/definitions/Missing' }, noRefs)).toBeNull();
  });
});

describe('buildSkeleton cycle handling', () => {
  it('cuts a directly self-referencing schema instead of recursing forever', () => {
    const definitions = {
      Node: { type: 'object', properties: { name: { type: 'string' }, child: { $ref: '#/definitions/Node' } } },
    };
    expect(buildSkeleton({ $ref: '#/definitions/Node' }, definitionsResolver(definitions)))
      .toEqual({ name: '', child: null });
  });

  it('cuts a mutually recursive pair', () => {
    const definitions = {
      A: { type: 'object', properties: { b: { $ref: '#/definitions/B' } } },
      B: { type: 'object', properties: { a: { $ref: '#/definitions/A' } } },
    };
    expect(buildSkeleton({ $ref: '#/definitions/A' }, definitionsResolver(definitions)))
      .toEqual({ b: { a: null } });
  });

  it('re-expands the same ref used twice in sibling positions', () => {
    // Sibling reuse is not a cycle — both branches must expand fully.
    const definitions = { Leaf: { type: 'object', properties: { v: { type: 'string' } } } };
    const schema = {
      type: 'object',
      properties: { left: { $ref: '#/definitions/Leaf' }, right: { $ref: '#/definitions/Leaf' } },
    };
    expect(buildSkeleton(schema, definitionsResolver(definitions)))
      .toEqual({ left: { v: '' }, right: { v: '' } });
  });

  it('stops at the depth cap for a cycle expressed without $ref', () => {
    let deep: any = { type: 'string' };
    for (let i = 0; i < 30; i += 1) deep = { type: 'object', properties: { next: deep } };
    // Terminates rather than hanging; the deepest node is cut to null.
    expect(() => buildSkeleton(deep, noRefs)).not.toThrow();
    expect(JSON.stringify(buildSkeleton(deep, noRefs))).toContain('null');
  });
});

describe('buildSkeleton composition', () => {
  it('merges allOf branches left to right', () => {
    const definitions = { Base: { type: 'object', properties: { id: { type: 'string' } } } };
    const schema = {
      allOf: [
        { $ref: '#/definitions/Base' },
        { type: 'object', properties: { extra: { type: 'boolean' } } },
      ],
    };
    expect(buildSkeleton(schema, definitionsResolver(definitions)))
      .toEqual({ id: '', extra: false });
  });

  it('lets a later allOf branch override an earlier property', () => {
    const schema = {
      allOf: [
        { type: 'object', properties: { v: { type: 'string' } } },
        { type: 'object', properties: { v: { type: 'integer' } } },
      ],
    };
    expect(buildSkeleton(schema, noRefs)).toEqual({ v: 0 });
  });

  it('keeps sibling keys alongside allOf', () => {
    const schema = {
      type: 'object',
      properties: { own: { type: 'string' } },
      allOf: [{ type: 'object', properties: { shared: { type: 'string' } } }],
    };
    expect(buildSkeleton(schema, noRefs)).toEqual({ shared: '', own: '' });
  });

  it('takes the first oneOf branch', () => {
    const schema = {
      oneOf: [
        { type: 'object', properties: { a: { type: 'string' } } },
        { type: 'object', properties: { b: { type: 'integer' } } },
      ],
    };
    expect(buildSkeleton(schema, noRefs)).toEqual({ a: '' });
  });

  it('takes the first anyOf branch', () => {
    expect(buildSkeleton({ anyOf: [{ type: 'integer' }, { type: 'string' }] }, noRefs)).toBe(0);
  });
});

describe('skeletonJson', () => {
  it('returns nothing at all for an operation that declares no body', () => {
    // `{}` is a real body and would be sent, which endpoints documenting no
    // body reject.
    expect(skeletonJson(null, noRefs)).toBe('');
    expect(skeletonJson(undefined, noRefs)).toBe('');
  });

  it('still returns an empty object when a declared body cannot be resolved', () => {
    // Here the user does need something to type into.
    expect(skeletonJson({ $ref: '#/definitions/Gone' }, noRefs)).toBe('{}');
  });

  it('pretty-prints with two-space indentation', () => {
    const json = skeletonJson({ type: 'object', properties: { id: { type: 'string' } } }, noRefs);
    expect(json).toBe('{\n  "id": ""\n}');
  });
});
