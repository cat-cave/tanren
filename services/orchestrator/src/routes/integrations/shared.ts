// in-20 — shared helpers + the read-surface scope type for the integration HTTP
// read store modules (`integrationReadStore.ts`, `integrationBindingsRead.ts`,
// `deliveryReadStore.ts`). Extracted so each store module stays well under the
// 500-line ceiling without duplicating the row-decode primitives.
//
// These helpers enforce the fail-closed posture: a NULL or wrong-typed DB field
// throws rather than slipping through a silent coerce. The store methods that
// call them surface the throw as a 500 (never a partial or laundered body).

export interface IntegrationReadScope {
  readonly orgId: string;
  readonly projectId: string;
}

/**
 * Decode a Postgres-derived datetime-ish value into a Date, or null. Throws on
 * a non-null, non-date-shaped value so a corrupt row fails closed rather than
 * silently rendering as `new Date(NaN)`.
 */
export function asDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new TypeError(`expected date, got invalid ${typeof value}`);
    }
    return parsed;
  }
  throw new TypeError(`expected date, got ${typeof value}`);
}

/**
 * Decode a count/integer aggregate, accepting Postgres's tendency to return
 * counts as strings under certain code paths. Throws on a non-integer or
 * negative value so a corrupt aggregate fails closed.
 */
export function asNonNegativeInt(value: unknown): number {
  const n = typeof value === "string" ? Number.parseInt(value, 10) : (value as number);
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError(`expected non-negative integer, got ${typeof value}`);
  }
  return n;
}

/** Decode a positive integer or null (e.g. `generation`), with the same coercion. */
export function asPositiveIntOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "string" ? Number.parseInt(value, 10) : (value as number);
  if (!Number.isInteger(n) || n < 1) {
    throw new TypeError(`expected positive integer or null, got ${typeof value}`);
  }
  return n;
}

/** Decode a string-or-null field; throws on a non-string, non-null value. */
export function asStringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new TypeError(`expected string or null, got ${typeof value}`);
  return value;
}

/** Filter a value to a string array; non-array inputs return an empty array. */
export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}
