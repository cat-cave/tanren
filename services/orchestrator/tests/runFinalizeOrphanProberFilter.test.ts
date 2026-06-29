// Audit finding D1 — the orphan-path consecutive-same-failure reader in
// `runFinalize.ts` mirrors the planner re-drive reader in `plannerRunRedrive.ts`,
// but PR #709 patched ONLY the planner reader's prober-resume filter. The orphan
// reader is the sibling that runs on a worker-level crash (the workflow finalizer
// never ran), reading the SAME `dag.spec.redriven` event class into the SAME
// convergence detector. Without the same filter, a paused-resumed spec whose
// runner subsequently crashes fed a polluted history
// (`internal@run, usage_limit@?, internal@run`) and the cycle judge read it as
// progress — masking a genuinely stuck spec across intervening pauses.
//
// This file pins the filter behavior so a future regression is loud.

import { describe, expect, it } from "vitest";
import type pg from "pg";
import { readOrphanConsecutive } from "../src/engine/worker/runFinalize.js";
import type { ClassifiedRunFailure } from "../src/engine/worker/runFailureClassifier.js";

/** A minimal `pg.PoolClient` substitute returning a fixed prior `dag.spec.redriven`
 * row list (oldest first — the orphan reader queries `ORDER BY ts ASC, id ASC`). */
function fakeClient(rows: { failureCode: string; stage?: string; workSignature?: string; source?: string }[]) {
  return {
    query: async (_sql: string) => ({ rows: rows.map((r) => ({ payload: r })), rowCount: rows.length }),
    release: () => {},
  } as unknown as pg.PoolClient;
}

const internalAtRun: ClassifiedRunFailure = {
  code: "internal",
  stage: "run",
  summary: "the run failed with an internal error",
};

describe("readOrphanConsecutive — the orphan-path FIXED-POINT read (0 = progress / re-drive; 1 = stuck / escalate)", () => {
  it("no prior re-drives ⇒ 0 (the first failure of its kind — PROGRESS, re-drive)", async () => {
    const got = await readOrphanConsecutive(fakeClient([]), "spec_1", internalAtRun);
    expect(got).toBe(0);
  });

  it("two SAME-signature priors ⇒ 1 (a proven cycle — escalate)", async () => {
    const got = await readOrphanConsecutive(
      fakeClient([
        { failureCode: "internal", stage: "run" },
        { failureCode: "internal", stage: "run" },
      ]),
      "spec_1",
      internalAtRun,
    );
    expect(got).toBe(1);
  });

  it("audit finding D1: dag.spec.redriven rows with source:'prober_resume' are FILTERED OUT of the orphan history", async () => {
    // The window-pause prober's resume writes a `dag.spec.redriven` event with a synthetic
    // `failureCode: "usage_limit"` (the spec pair-schema requires SOME failure code for an
    // `open` flip). If folded into the ORPHAN convergence history, a sequence
    // `internal@run, usage_limit@*, internal@run` reads as "a new state appeared between two
    // structural re-drives" — defeating cycle detection and masking a genuinely-stuck
    // paused-resumed spec on the worker-level crash path. The fix mirrors the planner reader
    // (finding #13): rows tagged `payload.source === "prober_resume"` are FILTERED OUT at
    // assembly time. After filtering, the reader sees two `internal@run` structural priors +
    // the current `internal@run` failure ⇒ a proven fixed point ⇒ ESCALATE (1).
    const got = await readOrphanConsecutive(
      fakeClient([
        { failureCode: "internal", stage: "run" },
        { failureCode: "usage_limit", stage: "agent", source: "prober_resume" },
        { failureCode: "internal", stage: "run" },
        { failureCode: "usage_limit", stage: "agent", source: "prober_resume" },
      ]),
      "spec_1",
      internalAtRun,
    );
    expect(got).toBe(1);
  });

  it("audit finding D1: a HISTORY of ONLY prober_resume rows reads as no structural priors ⇒ 0 (progress)", async () => {
    // After filtering, the history is empty and the current attempt is the FIRST structural
    // attempt — progress, re-drive (a paused-resumed spec hitting its first crash must NEVER
    // escalate just because the prober flipped the spec a couple of times).
    const got = await readOrphanConsecutive(
      fakeClient([
        { failureCode: "usage_limit", stage: "agent", source: "prober_resume" },
        { failureCode: "usage_limit", stage: "agent", source: "prober_resume" },
      ]),
      "spec_1",
      internalAtRun,
    );
    expect(got).toBe(0);
  });
});
