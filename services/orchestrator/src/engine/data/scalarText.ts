// Scalar-column coercion for raw pg rows.
//
// pg hands every column back as `unknown`. An id/text/enum column is a scalar
// (string | number | bigint | boolean), but reaching for `String(row[col])`
// over the raw `unknown` is unsafe: if the column ever holds an object (a jsonb
// value, a buffer) `String(...)` silently yields `[object Object]` — the
// `no-base-to-string` correctness rule flags exactly this. `scalarText` narrows
// the value to a real scalar and stringifies it; a non-scalar (object/array/
// symbol/function) THROWS rather than laundering garbage past the read seam
// (no silent fallback). `scalarTextOr` adds a fallback for a NULL/absent column.

export function scalarText(value: unknown): string {
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "bigint":
    case "boolean":
      return value.toString();
    default:
      throw new TypeError(`scalarText: expected a pg scalar column value, got ${typeof value}`);
  }
}

/** `scalarText` with a fallback for a NULL/absent column (the common `?? ""` shape). */
export function scalarTextOr(value: unknown, fallback: string): string {
  return value === null || value === undefined ? fallback : scalarText(value);
}

/**
 * A NULLABLE text column: `string` for a real value, `null` for a NULL/absent
 * column — the `(row.col ?? null) as string | null` shape at the read seam, without
 * the unsafe `as`. A non-scalar value THROWS (no silent laundering of a jsonb/buffer
 * past the seam), same fail-loud contract as `scalarText`.
 */
export function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : scalarText(value);
}
