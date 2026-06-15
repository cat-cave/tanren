// apex v35 — the re-drive APPLIER's reusable pieces (plannerRunRedrive.ts): the backoff
// growth + the consecutive-same-failure reader (`buildRedriveHistoryReader`). The
// CLASSIFICATION + the 3-bucket decision now live in the authority core
// (runFinalizeAuthority.ts, covered by runFinalizeAuthority.test.ts); this module owns the
// durable-event-log count the authority's bound keys off (a different code = progress = reset).

import { describe, expect, it } from "vitest";
import {
  buildRedriveHistoryReader,
  DEFAULT_REDRIVE_ESCALATE_AT,
  redriveBackoffSeconds,
} from "../src/engine/workflow/plannerRunRedrive.js";

describe("redriveBackoffSeconds — grows with the consecutive-same-failure count, capped", () => {
  it("grows linearly then caps", () => {
    const b1 = redriveBackoffSeconds(1);
    const b3 = redriveBackoffSeconds(3);
    expect(b3).toBeGreaterThan(b1);
    // Far past the cap the backoff stops growing (never an unbounded sleep).
    expect(redriveBackoffSeconds(1000)).toBe(redriveBackoffSeconds(10000));
  });

  it("the escalate cap K is a sane, bounded value", () => {
    expect(DEFAULT_REDRIVE_ESCALATE_AT).toBeGreaterThanOrEqual(3);
    expect(DEFAULT_REDRIVE_ESCALATE_AT).toBeLessThanOrEqual(5);
  });
});

/** A fake org-scoped pool returning a fixed prior-redriven event list (newest first). */
function fakePool(rows: { failureCode: string }[]) {
  return {
    connect: async () => ({
      query: async (sql: string) => {
        if (sql.includes("SET LOCAL") || sql.startsWith("SET") || sql.startsWith("BEGIN") || sql.startsWith("COMMIT")) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: rows.map((r) => ({ payload: r })), rowCount: rows.length };
      },
      release: () => {},
    }),
  } as never;
}

describe("buildRedriveHistoryReader — counts the trailing SAME-code run (a different code resets)", () => {
  it("no prior re-drives ⇒ 1 (the first failure of its kind)", async () => {
    const reader = buildRedriveHistoryReader(fakePool([]));
    expect(await reader({ orgId: "org_1", specId: "spec_1", code: "internal" })).toBe(1);
  });

  it("a trailing run of SAME-code prior re-drives counts (this failure included)", async () => {
    // Two prior `internal` re-drives + the current `internal` failure ⇒ 3.
    const reader = buildRedriveHistoryReader(fakePool([{ failureCode: "internal" }, { failureCode: "internal" }]));
    expect(await reader({ orgId: "org_1", specId: "spec_1", code: "internal" })).toBe(3);
  });

  it("a DIFFERENT prior code BREAKS the run (progress resets the streak)", async () => {
    // Newest prior is a `merge` re-drive (different from the current `internal`) ⇒ streak is just
    // the current one ⇒ 1, even though older `internal` re-drives exist.
    const reader = buildRedriveHistoryReader(
      fakePool([{ failureCode: "merge" }, { failureCode: "internal" }, { failureCode: "internal" }]),
    );
    expect(await reader({ orgId: "org_1", specId: "spec_1", code: "internal" })).toBe(1);
  });
});
