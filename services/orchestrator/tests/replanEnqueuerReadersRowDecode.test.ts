// Negative row-decode tests for the prior-replan / prior-gate-rework event readers.
// The two readers in `replanEnqueuerPg.ts` previously used a `client.query<{ payload:
// {...} }>` query generic — an unchecked cast that trusted the jsonb shape at runtime.
// They now decode each row through an explicit Zod schema, so a malformed/legacy
// payload fails as a typed validation error instead of silently coercing via `??`
// (which could mask data corruption as a wrong-but-plausible signature). These tests
// drive the REAL public readers (`buildPriorReplanReader` / `buildPriorGateReworkReader`)
// against a pool whose `events` rows are malformed, and assert each reader rejects with
// a Zod validation failure (not a silent empty/wrong result).

import { describe, expect, it } from "vitest";
import type pg from "pg";
import {
  buildPriorGateReworkReader,
  buildPriorReplanReader,
} from "../src/engine/workflow/reviewMerge/conflictResolver/replanEnqueuerPg.js";

const ORG = "org_row_decode";

/**
 * A minimal pool double classified as a pool by `isPool` (totalCount + connect) whose
 * checked-out client returns `rows` for every SELECT. `resolveEventsReadPool` falls
 * back to it (no system pool in unit tests), and `runWithOrgScope` opens its real
 * BEGIN/SET LOCAL/COMMIT lifecycle on the client. The rows are what the reader parses.
 */
function poolReturning(rows: unknown[]): pg.Pool {
  const query = async (): Promise<{ rows: unknown[]; rowCount: number }> => ({ rows, rowCount: rows.length });
  const client = { query, release: () => {} } as unknown as pg.PoolClient;
  return {
    query,
    connect: async () => client,
    totalCount: 0,
  } as unknown as pg.Pool;
}

describe("buildPriorReplanReader — Zod row decode", () => {
  it("decodes well-formed payloads into conflict signatures (legacy fallback hashes newContext)", async () => {
    const pool = poolReturning([
      { payload: { conflictSignature: "sig_a" } },
      // Legacy row: no conflictSignature ⇒ the detector falls back to a hash of
      // newContext + otherSpecId so it can still tell same-conflict from different.
      { payload: { newContext: "ctx", otherSpecId: "spec_other" } },
    ]);
    const reader = buildPriorReplanReader(pool);

    const signatures = await reader.signatures({ specId: "spec_1", orgId: ORG });

    expect(signatures).toHaveLength(2);
    expect(signatures[0]).toBe("sig_a");
    // The fallback signature is deterministic over (newContext, otherSpecId).
    expect(signatures[1]).toEqual(expect.any(String));
    expect(signatures[1]).not.toBe("");
  });

  it("REJECTS a null payload as a Zod validation failure (not an empty signature)", async () => {
    const pool = poolReturning([{ payload: null }]);
    const reader = buildPriorReplanReader(pool);

    await expect(reader.signatures({ specId: "spec_bad", orgId: ORG })).rejects.toThrow(/invalid_type/u);
  });

  it("REJECTS a payload whose conflictSignature is the wrong primitive type", async () => {
    const pool = poolReturning([{ payload: { conflictSignature: 123 } }]);
    const reader = buildPriorReplanReader(pool);

    await expect(reader.signatures({ specId: "spec_bad", orgId: ORG })).rejects.toThrow(/invalid_type/u);
  });

  it("REJECTS a row missing the payload column entirely", async () => {
    const pool = poolReturning([{ event_id: "evt_1" }]);
    const reader = buildPriorReplanReader(pool);

    await expect(reader.signatures({ specId: "spec_bad", orgId: ORG })).rejects.toThrow(/invalid_type/u);
  });
});

describe("buildPriorGateReworkReader — Zod row decode", () => {
  it("decodes well-formed reworked gate-error payloads into signatures", async () => {
    const pool = poolReturning([{ payload: { gateError: "tier lint: missing semicolon" } }]);
    const reader = buildPriorGateReworkReader(pool);

    const signatures = await reader({ specId: "spec_1", orgId: ORG });

    expect(signatures).toHaveLength(1);
    expect(signatures[0]).toEqual(expect.any(String));
    expect(signatures[0]).not.toBe("");
  });

  it("REJECTS a null payload as a Zod validation failure", async () => {
    const pool = poolReturning([{ payload: null }]);
    const reader = buildPriorGateReworkReader(pool);

    await expect(reader({ specId: "spec_bad", orgId: ORG })).rejects.toThrow(/invalid_type/u);
  });

  it("REJECTS a payload whose gateError is the wrong primitive type", async () => {
    const pool = poolReturning([{ payload: { gateError: { nested: "object" } } }]);
    const reader = buildPriorGateReworkReader(pool);

    await expect(reader({ specId: "spec_bad", orgId: ORG })).rejects.toThrow(/invalid_type/u);
  });

  it("REJECTS a payload that is itself a non-object primitive", async () => {
    const pool = poolReturning([{ payload: "not-an-object" }]);
    const reader = buildPriorGateReworkReader(pool);

    await expect(reader({ specId: "spec_bad", orgId: ORG })).rejects.toThrow(/invalid_type/u);
  });
});
