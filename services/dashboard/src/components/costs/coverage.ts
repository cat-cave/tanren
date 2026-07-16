/** Honest coverage state for a nullable monetary axis. */

export type MonetaryCoverage =
  | { kind: "empty"; knownUsd: null; pricedRecords: 0; unpricedRecords: 0 }
  | { kind: "unknown"; knownUsd: null; pricedRecords: 0; unpricedRecords: number }
  | { kind: "known"; knownUsd: number; pricedRecords: number; unpricedRecords: 0 }
  | { kind: "partial"; knownUsd: number; pricedRecords: number; unpricedRecords: number };

/** Null is unknown, while a numeric zero remains a genuine known zero. */
export function monetaryCoverage(values: readonly (string | null)[]): MonetaryCoverage {
  if (values.length === 0) {
    return { kind: "empty", knownUsd: null, pricedRecords: 0, unpricedRecords: 0 };
  }
  let knownUsd = 0;
  let pricedRecords = 0;
  let unpricedRecords = 0;
  for (const value of values) {
    if (value === null) {
      unpricedRecords += 1;
      continue;
    }
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) {
      // The strict HTTP decoder rejects this in production. Preserve fail-safe
      // semantics for direct pure-function callers rather than inventing zero.
      unpricedRecords += 1;
      continue;
    }
    knownUsd += amount;
    pricedRecords += 1;
  }
  if (pricedRecords === 0) {
    return { kind: "unknown", knownUsd: null, pricedRecords: 0, unpricedRecords };
  }
  if (unpricedRecords > 0) {
    return { kind: "partial", knownUsd, pricedRecords, unpricedRecords };
  }
  return { kind: "known", knownUsd, pricedRecords, unpricedRecords: 0 };
}
