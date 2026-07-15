// Behavioral row-decode tests for prior-replan / prior-gate-rework event readers.
// Drive the real public seams (buildPriorReplanReader / buildPriorGateReworkReader):
// well-formed rows become signatures; malformed/null/non-object/wrong-type rows
// fail closed as Zod validation errors (never silent ?? coercion into signatures).

import { describe, expect, it } from "vitest";
import type pg from "pg";
import {
  buildPriorGateReworkReader,
  buildPriorReplanReader,
} from "../src/engine/workflow/reviewMerge/conflictResolver/replanEnqueuerPg.js";
import {
  conflictSignatureOf,
  gateErrorSignature,
} from "../src/engine/workflow/reviewMerge/conflictResolver/replanRouter.js";

const ORG = "org_row_decode";

/**
 * Pool double for runWithOrgScope (connect + BEGIN/SET LOCAL/COMMIT lifecycle).
 * Returns `rows` for every SELECT — the payloads the reader Zod-parses.
 */
function poolReturning(rows: unknown[]): pg.Pool {
  // eslint-disable-next-line @typescript-eslint/require-await
  const query = async (): Promise<{ rows: unknown[]; rowCount: number }> => ({
    rows,
    rowCount: rows.length,
  });
  return {
    query,
    // eslint-disable-next-line @typescript-eslint/require-await
    connect: async () => ({ query, release: () => {} }),
  } as unknown as pg.Pool;
}

describe("buildPriorReplanReader — Zod row decode", () => {
  it("decodes well-formed payloads into conflict signatures", async () => {
    const pool = poolReturning([
      { payload: { conflictSignature: "sig_a" } },
      { payload: { newContext: "ctx", otherSpecId: "spec_other" } },
    ]);
    const signatures = await buildPriorReplanReader(pool).signatures({ specId: "spec_1", orgId: ORG });

    expect(signatures).toEqual(["sig_a", conflictSignatureOf("ctx", "spec_other")]);
  });

  it("REJECTS a null payload (not an empty signature)", async () => {
    await expect(
      buildPriorReplanReader(poolReturning([{ payload: null }])).signatures({
        specId: "spec_bad",
        orgId: ORG,
      }),
    ).rejects.toThrow(/invalid_type/u);
  });

  it("REJECTS a payload whose conflictSignature is the wrong primitive type", async () => {
    await expect(
      buildPriorReplanReader(poolReturning([{ payload: { conflictSignature: 123 } }])).signatures({
        specId: "spec_bad",
        orgId: ORG,
      }),
    ).rejects.toThrow(/invalid_type/u);
  });

  it("REJECTS a non-object payload primitive", async () => {
    await expect(
      buildPriorReplanReader(poolReturning([{ payload: "not-an-object" }])).signatures({
        specId: "spec_bad",
        orgId: ORG,
      }),
    ).rejects.toThrow(/invalid_type/u);
  });

  it("REJECTS a row missing the payload column", async () => {
    await expect(
      buildPriorReplanReader(poolReturning([{ event_id: "evt_1" }])).signatures({
        specId: "spec_bad",
        orgId: ORG,
      }),
    ).rejects.toThrow(/invalid_type/u);
  });
});

describe("buildPriorGateReworkReader — Zod row decode", () => {
  it("decodes well-formed reworked gate-error payloads into signatures", async () => {
    const err = "tier lint: missing semicolon";
    const signatures = await buildPriorGateReworkReader(poolReturning([{ payload: { gateError: err } }]))({
      specId: "spec_1",
      orgId: ORG,
    });

    expect(signatures).toEqual([gateErrorSignature(err)]);
  });

  it("REJECTS a null payload", async () => {
    await expect(
      buildPriorGateReworkReader(poolReturning([{ payload: null }]))({ specId: "spec_bad", orgId: ORG }),
    ).rejects.toThrow(/invalid_type/u);
  });

  it("REJECTS a payload whose gateError is the wrong primitive type", async () => {
    await expect(
      buildPriorGateReworkReader(poolReturning([{ payload: { gateError: { nested: "object" } } }]))({
        specId: "spec_bad",
        orgId: ORG,
      }),
    ).rejects.toThrow(/invalid_type/u);
  });

  it("REJECTS a non-object payload primitive", async () => {
    await expect(
      buildPriorGateReworkReader(poolReturning([{ payload: "not-an-object" }]))({
        specId: "spec_bad",
        orgId: ORG,
      }),
    ).rejects.toThrow(/invalid_type/u);
  });

  it("REJECTS a row missing the payload column", async () => {
    await expect(buildPriorGateReworkReader(poolReturning([{}]))({ specId: "spec_bad", orgId: ORG })).rejects.toThrow(
      /invalid_type/u,
    );
  });
});
