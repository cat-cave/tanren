// Focused isPool shape tests: the totalCount discriminator (arm 1) and its precedence
// over the release guard (arm 2). Kept in its own file so `orgScopeResolvers.test.ts`
// (494 lines) stays under the 500-line cap.
//
// arm 1: connect function + `totalCount` of type number ⇒ real Pool (returns true).
// arm 2: `release` function ⇒ PoolClient (returns false — never re-checkout).
// arm 3: connect function, no release, no totalCount ⇒ minimal test double (true).
//
// The real `WorkerPool` test helper carries BOTH `totalCount` (number) AND `release()`
// (a no-op). It remains a pool because arm 1 (numeric totalCount) is evaluated BEFORE
// arm 2 (release) — the ordering is what prevents a real-Pool-shaped double from being
// misclassified as a PoolClient. A nonnumeric totalCount must NOT satisfy arm 1 (it
// would let a poisoned PoolClient slip past the release guard if presence alone were
// the check).

import type pg from "pg";
import { describe, expect, it } from "vitest";
import { isPool } from "../src/engine/data/orgScopedDb.js";
import { WorkerPool } from "./helpers/workerPool.js";

const queryStub = async (): Promise<{ rows: never[] }> => ({ rows: [] });

describe("isPool — totalCount numeric discriminator (arm 1)", () => {
  it("REJECTS a PoolClient-shaped client whose totalCount is nonnumeric (falls past arm 1 to the release guard)", () => {
    // Without the `typeof === "number"` check, arm 1 would fire on `"totalCount" in
    // client` presence alone and return true — re-checkout of an in-transaction client.
    // The numeric check makes arm 1 fail, so arm 2 (release) correctly classifies it.
    const poisoned = {
      query: queryStub,
      connect: () => ({}),
      totalCount: "not-a-number",
      release: () => {},
    } as unknown as pg.PoolClient;
    expect(isPool(poisoned)).toBe(false);
  });

  it("REJECTS a boolean totalCount (presence without a real counter)", () => {
    // A truthy-but-nonnumeric totalCount (e.g. `true`) is not a live pool counter.
    const client = {
      query: queryStub,
      connect: () => ({}),
      totalCount: true,
      release: () => {},
    } as unknown as pg.PoolClient;
    expect(isPool(client)).toBe(false);
  });
});

describe("isPool — real WorkerPool totalCount+release shape stays a pool", () => {
  it("classifies the WorkerPool helper as a pool despite its no-op release()", () => {
    // WorkerPool carries totalCount (number, a live counter) AND release() (a no-op).
    // arm 1 fires first (numeric totalCount) and returns true; arm 2 (release) is never
    // reached. Reversing the arm order would misclassify every real-Pool-shaped double
    // that also happens to expose release — so the ordering is the load-bearing guard.
    const workerPool = new WorkerPool();
    expect(isPool(workerPool.asPgPool())).toBe(true);
  });

  it("a numeric totalCount + connect (no release) double is a pool via arm 1", () => {
    // The canonical arm-1 shape: connect + numeric totalCount, no release.
    const realPoolShape = { query: queryStub, connect: () => ({}), totalCount: 5 } as unknown as pg.Pool;
    expect(isPool(realPoolShape)).toBe(true);
  });
});
