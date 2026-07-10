// Shared runtime JSON guards for CLI flag values. Keeps command modules free of
// ad-hoc `JSON.parse(...) as T` casts that accept arrays / null / primitives.

/** Parse a CLI flag value as a non-null, non-array JSON object. */
export function parseJsonObject(raw: string, flag: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`--${flag} is not valid JSON: ${detail}`, { cause: error });
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
