// apex v35 — the re-drive APPLIER's reusable pieces (plannerRunRedrive.ts): the backoff
// growth + the FIXED-POINT reader (`buildRedriveHistoryReader`). The CLASSIFICATION + the
// 3-bucket decision live in the authority core (runFinalizeAuthority.ts); this module owns
// the durable-event-log read the shared convergence detector reasons over — there is NO
// hardcoded attempt cap: a loop re-drives UNBOUNDED while it CHANGES its failure OR its
// produced work, and is at a fixed point ONLY when the latest attempt is structurally
// identical to the prior (same failure code AND same — or unobservable — work).

import { describe, expect, it } from "vitest";
import { buildRedriveHistoryReader, redriveBackoffSeconds } from "../src/engine/workflow/plannerRunRedrive.js";

describe("redriveBackoffSeconds — grows with the fixed-point streak, capped (the hot-loop guard, not a count)", () => {
  it("grows linearly then caps", () => {
    const b1 = redriveBackoffSeconds(1);
    const b3 = redriveBackoffSeconds(3);
    expect(b3).toBeGreaterThan(b1);
    // Far past the cap the backoff stops growing (never an unbounded sleep).
    expect(redriveBackoffSeconds(1000)).toBe(redriveBackoffSeconds(10000));
  });
});

/** A fake org-scoped pool returning a fixed prior-redriven event list (oldest first — the
 * reader queries `ORDER BY ts ASC`). Each row is the prior re-drive's payload. */
function fakePool(rows: { failureCode: string; workSignature?: string }[]) {
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

describe("buildRedriveHistoryReader — the fixed-point read (0 = progress / re-drive; 1 = stuck / escalate)", () => {
  it("no prior re-drives ⇒ 0 (the first failure of its kind — PROGRESS, re-drive)", async () => {
    const reader = buildRedriveHistoryReader(fakePool([]));
    expect(await reader({ orgId: "org_1", specId: "spec_1", code: "internal" })).toBe(0);
  });

  it("the SAME failure code recurring (no work signature) ⇒ 1 (a FIXED POINT — escalate)", async () => {
    // A prior `internal` re-drive + the current `internal` failure, neither with an observable
    // work signature ⇒ the failure-code axis alone is a fixed point.
    const reader = buildRedriveHistoryReader(fakePool([{ failureCode: "internal" }]));
    expect(await reader({ orgId: "org_1", specId: "spec_1", code: "internal" })).toBe(1);
  });

  it("a DIFFERENT prior code is PROGRESS ⇒ 0 (re-drive, UNBOUNDED — a changing failure never escalates)", async () => {
    // The newest prior is a `merge` re-drive (different from the current `internal`) ⇒ the
    // latest advanced ⇒ progress, even after many prior re-drives.
    const reader = buildRedriveHistoryReader(
      fakePool([{ failureCode: "internal" }, { failureCode: "internal" }, { failureCode: "merge" }]),
    );
    expect(await reader({ orgId: "org_1", specId: "spec_1", code: "internal" })).toBe(0);
  });

  it("the SAME failure code but DIFFERENT produced work is PROGRESS ⇒ 0 (the agent did something different)", async () => {
    // Same `internal` code as the prior, but the prior produced a different head sha than this
    // run will — so the WORK axis advanced ⇒ progress, re-drive.
    const reader = buildRedriveHistoryReader(fakePool([{ failureCode: "internal", workSignature: "sha-A" }]));
    expect(await reader({ orgId: "org_1", specId: "spec_1", code: "internal", workSignature: "sha-B" })).toBe(0);
  });

  it("the SAME failure code AND the SAME produced work is a FIXED POINT ⇒ 1 (identical output, identical failure)", async () => {
    const reader = buildRedriveHistoryReader(fakePool([{ failureCode: "internal", workSignature: "sha-A" }]));
    expect(await reader({ orgId: "org_1", specId: "spec_1", code: "internal", workSignature: "sha-A" })).toBe(1);
  });

  it("a long run of CHANGING failures NEVER reaches a fixed point (UNBOUNDED progress, far past any old K)", async () => {
    // 8 prior re-drives, each a different code ending in a code different from the current ⇒
    // the latest advanced ⇒ progress (0), no matter how many attempts precede it.
    const reader = buildRedriveHistoryReader(
      fakePool([
        { failureCode: "internal" },
        { failureCode: "merge" },
        { failureCode: "internal" },
        { failureCode: "deploy" },
        { failureCode: "internal" },
        { failureCode: "merge" },
        { failureCode: "deploy" },
        { failureCode: "merge" },
      ]),
    );
    expect(await reader({ orgId: "org_1", specId: "spec_1", code: "internal" })).toBe(0);
  });
});
