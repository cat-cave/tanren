// Type-safe accessors for Hono `parseBody` results.
//
// `c.req.parseBody()` types each field as `string | File` (or, with
// `{ all: true }`, `string | File | (string | File)[]`). Reaching for
// `String(form[key] ?? "")` is unsafe: `String(File)` / `String(array)` produce
// `[object Object]` / a comma-joined blob (the `no-base-to-string` correctness
// rule flags exactly this). These helpers narrow the union at the read seam —
// a `File` (a non-text upload landing where a text field is expected) or an
// array yields the empty string / its first text member, never a stringified
// object.

// A parsed-body record. Hono types each value `string | File` (or, with
// `{ all: true }`, `string | File | (string | File)[]`); some callers hand a
// looser `Record<string, unknown>` (a hand-rolled form object). Accept the
// widest shape and narrow per-value at read — the helper only ever returns a
// real string.
type ParsedBody = Record<string, unknown>;

/** First string member of a parsed-body value, or `undefined` if none (File/array-only). */
function firstString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string") return item;
    }
  }
  return undefined;
}

/** Read a single text form field, falling back to `fallback` (default `""`). */
export function formField(form: ParsedBody, key: string, fallback = ""): string {
  return firstString(form[key]) ?? fallback;
}
