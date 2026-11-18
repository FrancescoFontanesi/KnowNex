/** Throws an Error whose message and `code` are the given code. */
export function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}

/** A JSON object: not null and not an array. */
export const object = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x);
