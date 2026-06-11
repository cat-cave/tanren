// The TYPED pg-row read seam.
//
// pg types `QueryResult.rows` as `any[]` (its `QueryResultRow` index signature is
// `[column: string]: any`). Reaching `result.rows[0] as RawSomeRow` to give that
// `any` a shape is an UNSAFE assertion — `no-unsafe-type-assertion` flags exactly
// this "assert FROM `any`" at every DB read site. The fix is the same
// trust-at-boundary doctrine the repositories already apply (zod-decode each row
// into its contract type at the read seam), made cast-free at the seam two ways:
//
//   1. TYPE the read instead of casting it. pg's `query` is generic
//      (`query<R extends QueryResultRow>(...) => QueryResult<R>` with `rows: R[]`),
//      and a raw-row interface (every column `unknown`) / `RawRow`
//      (`Record<string, unknown>`) satisfies that constraint. So
//      `client.query<RawSomeRow>(...)` hands back already-typed rows with ZERO
//      assertion — the decoder reads `raw.snake_case` (each `unknown`, forcing a
//      narrow/zod-parse) and a `result.rows[0] as RawSomeRow` never appears.
//   2. VALIDATE the leaf narrows the row-type can't express — an enum column
//      (`oneOf`) and a guaranteed `RETURNING` row (`requireRow`) — fail-loud, the
//      read-side twin of `scalarText` (the column-coercion seam in this folder).
//
// No silent fallback: a column outside its vocabulary, or a `RETURNING` that
// matched nothing, THROWS rather than laundering a bad value / a quiet `undefined`
// past the seam.
//
// A "raw row" is just `Record<string, unknown>` (or a per-table interface of
// `unknown` columns) — each store declares its own; this module is the shared
// fail-loud leaf-validators (`oneOf` / `requireRow`) the typed reads lean on.

/**
 * Assert a row an `INSERT/UPDATE ... RETURNING` is GUARANTEED to produce (pg still
 * types `rows[0]` as `T | undefined`). Fail-loud — a missing row means the write
 * matched nothing (a real bug / a vanished id), never a silent `undefined`.
 */
export function requireRow<T>(row: T | undefined, context: string): T {
  if (row === undefined) {
    throw new Error(`requireRow: expected a returned row for ${context}, got none`);
  }
  return row;
}

/**
 * Narrow a raw enum-column value (an `unknown`/`string` off a pg row) to one of a
 * fixed set of string literals — the `row.col as SomeUnion` shape at the read seam,
 * VALIDATED instead of asserted. The `allowed` tuple IS the contract type, so a new
 * union member is a compile-time obligation here. Fail-loud on an out-of-vocabulary
 * value (a column drift / a corrupt row), never a silent coerce — the same posture
 * as a zod enum, for the union types the codebase carries as plain TS literals.
 */
export function oneOf<const T extends string>(value: unknown, allowed: readonly T[], context: string): T {
  for (const candidate of allowed) {
    if (value === candidate) {
      return candidate;
    }
  }
  throw new TypeError(`oneOf: ${context}: ${JSON.stringify(value)} is not one of ${JSON.stringify(allowed)}`);
}
