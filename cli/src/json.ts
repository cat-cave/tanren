// Shared runtime JSON guards for CLI flag values. Keeps command modules free of
// ad-hoc `JSON.parse(...) as T` casts that accept arrays / null / primitives.
//
// Parse failures use a stable, redacted error text — never the raw JSON.parse
// `.message`, which on some Node versions can include a snippet of the input
// (and thus any secrets embedded in a malformed blob).

/** Parse a CLI flag value as a non-null, non-array JSON object. */
export function parseJsonObject(raw: string, flag: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    // Do not embed `error.message` — it may contain input snippets.
    throw new Error(`--${flag} is not valid JSON`, { cause: error });
  }
  if (!isPlainObject(value)) {
    throw new Error(`--${flag} must be a JSON object`);
  }
  return value;
}

/** True for plain objects only (rejects null and arrays). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Require a non-empty string field on a plain object. */
export function requireNonEmptyString(obj: Record<string, unknown>, key: string, label: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must include non-empty string field "${key}"`);
  }
  return value;
}

/**
 * Reject unknown keys on a plain object (mirrors Zod `.strict()`).
 * `label` is the flag / field path used in the error message.
 */
export function rejectUnknownKeys(obj: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(obj).filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    throw new Error(`${label} has unknown field(s): ${unknown.join(", ")}`);
  }
}
