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
 * reader queries `ORDER BY ts ASC`). Each row is the prior re-drive's payload. The reader
 * issues TWO queries: the redriven history + the spec-level PR/merge first-timestamps (apex
 * v67 #122). The fake routes them by SQL substring; the PR/merge query returns no rows by
 * default (no progress markers) so the wandering verdict stays "not wandering" in the
 * fixed-point matrix tests below. The `source` field rides each row so the prober_resume
 * filter (audit finding #13) can be exercised. */
function fakePool(rows: { failureCode: string; workSignature?: string; source?: string }[]) {
  return {
    connect: async () => ({
      query: async (sql: string) => {
        if (sql.includes("SET LOCAL") || sql.startsWith("SET") || sql.startsWith("BEGIN") || sql.startsWith("COMMIT")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("github.pr.created")) {
          // The progress-markers query (apex v67 #122). No rows ⇒ no markers ever set.
          return { rows: [], rowCount: 0 };
        }
        // The dag.spec.redriven history query. Stamp a synthesized `ts` so the reader can
        // compare against the (absent) progress-markers timestamps; the value is opaque.
        return {
          rows: rows.map((r, i) => ({ payload: r, ts: new Date(1_000_000_000_000 + i).toISOString() })),
          rowCount: rows.length,
        };
      },
      release: () => {},
    }),
  } as never;
}

/** The reader now returns a discriminated union `{ kind: "ok", priorSameFixedPoint, wandering }
 * | { kind: "read_failed", error }` (audit C2 #3 — silent-fallback hardening). The existing
 * matrix asserts only the fixed-point count on the ok branch; this helper narrows so the
 * assertions stay readable + throws loudly if a happy-path fixture returns read_failed. */
async function fixedPointCount(
  reader: ReturnType<typeof buildRedriveHistoryReader>,
  facts: { orgId: string; specId: string; code: "internal" | "merge"; workSignature?: string },
): Promise<number> {
  const result = await reader({ ...facts, stage: "run" });
  if (result.kind !== "ok") {
    throw new Error(`expected an ok read but got ${result.kind}`);
  }
  return result.priorSameFixedPoint;
}

describe("buildRedriveHistoryReader — the fixed-point read (0 = progress / re-drive; 1 = stuck / escalate)", () => {
  it("no prior re-drives ⇒ 0 (the first failure of its kind — PROGRESS, re-drive)", async () => {
    const reader = buildRedriveHistoryReader(fakePool([]));
    expect(await fixedPointCount(reader, { orgId: "org_1", specId: "spec_1", code: "internal" })).toBe(0);
  });

  it("a SINGLE same-code repeat (no work signature) ⇒ 0 (NOT an instant fixed point — a transient may recur once)", async () => {
    // A 2nd identical `internal` failure with NO observable produced work is NOT proof of a
    // dead-end (it may be a transient flake recurring once) — the disguised-K=2 fix. The
    // cycle-aware judge keeps re-driving until the recurrence is evidenced beyond one repeat.
    const reader = buildRedriveHistoryReader(fakePool([{ failureCode: "internal" }]));
    expect(await fixedPointCount(reader, { orgId: "org_1", specId: "spec_1", code: "internal" })).toBe(0);
  });

  it("the SAME no-work failure RECURRING (a cycle: ≥2 priors) ⇒ 1 (a proven FIXED POINT — escalate)", async () => {
    // Two prior `internal` re-drives + the current `internal` failure, no observable work ⇒
    // the state has recurred beyond the immediate neighbor ⇒ a cycle ⇒ the judge escalates.
    const reader = buildRedriveHistoryReader(fakePool([{ failureCode: "internal" }, { failureCode: "internal" }]));
    expect(await fixedPointCount(reader, { orgId: "org_1", specId: "spec_1", code: "internal" })).toBe(1);
  });

  it("a DIFFERENT prior code is PROGRESS ⇒ 0 (re-drive, UNBOUNDED — a changing failure never escalates)", async () => {
    // The newest prior is a `merge` re-drive (different from the current `internal`) ⇒ the
    // latest advanced ⇒ progress, even after many prior re-drives.
    const reader = buildRedriveHistoryReader(
      fakePool([{ failureCode: "internal" }, { failureCode: "internal" }, { failureCode: "merge" }]),
    );
    expect(await fixedPointCount(reader, { orgId: "org_1", specId: "spec_1", code: "internal" })).toBe(0);
  });

  it("the SAME failure code but DIFFERENT produced work is PROGRESS ⇒ 0 (the agent did something different)", async () => {
    // Same `internal` code as the prior, but the prior produced a different head sha than this
    // run will — so the WORK axis advanced ⇒ progress, re-drive.
    const reader = buildRedriveHistoryReader(fakePool([{ failureCode: "internal", workSignature: "sha-A" }]));
    expect(
      await fixedPointCount(reader, { orgId: "org_1", specId: "spec_1", code: "internal", workSignature: "sha-B" }),
    ).toBe(0);
  });

  it("the SAME failure code AND the SAME produced work is a FIXED POINT ⇒ 1 (identical output, identical failure)", async () => {
    const reader = buildRedriveHistoryReader(fakePool([{ failureCode: "internal", workSignature: "sha-A" }]));
    expect(
      await fixedPointCount(reader, { orgId: "org_1", specId: "spec_1", code: "internal", workSignature: "sha-A" }),
    ).toBe(1);
  });

  it("a long run of NEW produced work each attempt NEVER reaches a fixed point (UNBOUNDED progress)", async () => {
    // 8 prior re-drives, each producing a DIFFERENT head sha (the agent kept doing something
    // different) ⇒ the work axis advances every attempt ⇒ progress (0), no matter how many.
    const reader = buildRedriveHistoryReader(
      fakePool(Array.from({ length: 8 }, (_unused, i) => ({ failureCode: "internal", workSignature: `sha-${i}` }))),
    );
    expect(
      await fixedPointCount(reader, { orgId: "org_1", specId: "spec_1", code: "internal", workSignature: "sha-new" }),
    ).toBe(0);
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
    expect(await fixedPointCount(reader, { orgId: "org_1", specId: "spec_1", code: "internal" })).toBe(1);
  });

  it("audit finding #13: dag.spec.redriven rows with source:'prober_resume' are FILTERED OUT of the convergence history", async () => {
    // The window-pause prober's resume writes a `dag.spec.redriven` event with a synthetic
    // `failureCode: "usage_limit"` (the spec pair-schema requires SOME failure code for an
    // `open` flip). If folded into the convergence history, a sequence
    // `internal, usage_limit, internal` reads as "a new state appeared between two
    // structural re-drives" — defeating cycle detection and masking a genuinely stuck spec.
    //
    // The fix: rows tagged `payload.source === "prober_resume"` are FILTERED OUT at assembly
    // time. The reader sees only the structural re-drives: two `internal` priors + the
    // current `internal` failure ⇒ a proven fixed point ⇒ ESCALATE (1).
    const reader = buildRedriveHistoryReader(
      fakePool([
        { failureCode: "internal" },
        { failureCode: "usage_limit", source: "prober_resume" },
        { failureCode: "internal" },
        { failureCode: "usage_limit", source: "prober_resume" },
      ]),
    );
    expect(await fixedPointCount(reader, { orgId: "org_1", specId: "spec_1", code: "internal" })).toBe(1);
  });

  it("audit finding #13: a HISTORY of ONLY prober_resume rows reads as no structural priors ⇒ 0 (progress)", async () => {
    // Two prober resumes between structural attempts must not promote a first-of-its-kind
    // structural failure into a fixed point. After filtering, the history is empty and the
    // current attempt is the FIRST structural attempt — progress, re-drive.
    const reader = buildRedriveHistoryReader(
      fakePool([
        { failureCode: "usage_limit", source: "prober_resume" },
        { failureCode: "usage_limit", source: "prober_resume" },
      ]),
    );
    expect(await fixedPointCount(reader, { orgId: "org_1", specId: "spec_1", code: "internal" })).toBe(0);
  });
});

/** A pool whose scoped connection throws on `SELECT payload ...` — simulating a DB
 * read failure (RLS mis-scope, transient hiccup, corrupt row payload). The `SET LOCAL`
 * / `BEGIN` / `COMMIT` control queries succeed so the transaction opens as normal;
 * the domain query is the one that blows up. */
function throwingPool(error: Error) {
  return {
    connect: async () => ({
      query: async (sql: string) => {
        if (sql.includes("SET LOCAL") || sql.startsWith("SET") || sql.startsWith("BEGIN") || sql.startsWith("COMMIT")) {
          return { rows: [], rowCount: 0 };
        }
        throw error;
      },
      release: () => {},
    }),
  } as never;
}

describe("audit C2 #3 — buildRedriveHistoryReader surfaces read_failed instead of silently returning progress", () => {
  it("a DB read failure returns `read_failed` with the caught error — never `{ priorSameFixedPoint: 0 }`", async () => {
    // The audit invariant: a persistent DB read failure must NOT silently disable the
    // persistent-failure escalation. Before the fix the reader returned facts
    // structurally identical to a fresh spec (priorSameFixedPoint: 0, wandering: false),
    // and the disposition-decider would forever re-drive a genuinely-stuck spec while
    // the DB was broken.
    const dbError = new Error("connection reset while reading dag.spec.redriven history");
    const reader = buildRedriveHistoryReader(throwingPool(dbError));
    const result = await reader({ orgId: "org_1", specId: "spec_stuck", code: "internal", stage: "run" });

    expect(result.kind).toBe("read_failed");
    if (result.kind !== "read_failed") throw new Error("expected read_failed");
    expect(result.error).toBe(dbError);
  });

  it("a wandering-halt CANNOT falsely say `wandering: false` on a read failure — the discriminant surfaces", async () => {
    // On a broken read the reader must NOT return `{ wandering: false }` (that would be
    // indistinguishable from "no re-drives yet — obviously not wandering"). Instead, it
    // surfaces `read_failed`, so the caller (`readConvergenceFacts`) defers the wandering
    // assessment to the next tick. This is the audit invariant for the wandering-halt
    // escalation: it must not be silently disabled by a DB blip.
    const dbError = new Error("db read timed out");
    const reader = buildRedriveHistoryReader(throwingPool(dbError));
    const result = await reader({ orgId: "org_1", specId: "spec_1", code: "internal", stage: "run" });

    // The result is NOT a "wandering: false" shape — the discriminant is `read_failed`,
    // so the caller CANNOT be tricked into believing the wandering assessment succeeded.
    expect(result.kind).toBe("read_failed");
    expect(result).not.toHaveProperty("wandering");
    expect(result).not.toHaveProperty("priorSameFixedPoint");
  });
});
