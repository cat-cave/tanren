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

  it("a SINGLE same-code repeat (no work signature) ⇒ 0 (NOT an instant fixed point — a transient may recur once)", async () => {
    // A 2nd identical `internal` failure with NO observable produced work is NOT proof of a
    // dead-end (it may be a transient flake recurring once) — the disguised-K=2 fix. The
    // cycle-aware judge keeps re-driving until the recurrence is evidenced beyond one repeat.
    const reader = buildRedriveHistoryReader(fakePool([{ failureCode: "internal" }]));
    expect(await reader({ orgId: "org_1", specId: "spec_1", code: "internal" })).toBe(0);
  });

  it("the SAME no-work failure RECURRING (a cycle: ≥2 priors) ⇒ 1 (a proven FIXED POINT — escalate)", async () => {
    // Two prior `internal` re-drives + the current `internal` failure, no observable work ⇒
    // the state has recurred beyond the immediate neighbor ⇒ a cycle ⇒ the judge escalates.
    const reader = buildRedriveHistoryReader(fakePool([{ failureCode: "internal" }, { failureCode: "internal" }]));
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

  it("a long run of NEW produced work each attempt NEVER reaches a fixed point (UNBOUNDED progress)", async () => {
    // 8 prior re-drives, each producing a DIFFERENT head sha (the agent kept doing something
    // different) ⇒ the work axis advances every attempt ⇒ progress (0), no matter how many.
    const reader = buildRedriveHistoryReader(
      fakePool(Array.from({ length: 8 }, (_unused, i) => ({ failureCode: "internal", workSignature: `sha-${i}` }))),
    );
    expect(await reader({ orgId: "org_1", specId: "spec_1", code: "internal", workSignature: "sha-new" })).toBe(0);
  });

  it("an OSCILLATION among a FIXED set of failures with no new work reaches a fixed point ⇒ 1 (the soft-brick)", async () => {
    // The corrected doctrine: a loop rotating among only already-seen failures (no NEW failure
    // type, no observable produced work, no magnitude trend) is CYCLING, not progressing — the
    // exact A→B→A→B soft-brick the audit flagged. It escalates instead of re-driving forever.
    const reader = buildRedriveHistoryReader(
      fakePool([
        { failureCode: "internal" },
        { failureCode: "merge" },
        { failureCode: "internal" },
        { failureCode: "merge" },
      ]),
    );
    expect(await reader({ orgId: "org_1", specId: "spec_1", code: "internal" })).toBe(1);
  });
});
