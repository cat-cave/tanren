// BaseShiftCoordinator never-discard unit tests; scripted seams, no runner/DB. The shared
// in-memory seams + the `harness`/`reexec` drivers live in `dagBaseShiftCoordinator.fixtures.ts`
// (extracted to keep both files under the 500-line architecture cap).

import { describe, expect, it } from "vitest";
import { decideSettle } from "../src/engine/contracts/changePercolation.js";
import { IntegrationRebasePayload } from "../src/engine/events/schemas/dag.js";
import { BaseShiftHeldError } from "../src/engine/dag/baseShiftCoordinator.js";
import { DEFAULT_STACK, DEP_BRANCH, DEP_RUN, harness, reexec } from "./dagBaseShiftCoordinator.fixtures.js";

describe("BaseShiftCoordinator — never-discard rebase (NOT supersede+regenerate)", () => {
  it("THE PROOF: an ancestor lands ⇒ the dependent's run row is the SAME run_id (rebase, no new run)", async () => {
    const h = harness({ conflictOnRebase: false, reGate: "passed" });
    const result = await reexec(h);

    // (1) NEVER-DISCARD: the re-exec run id IS the dependent's OWN run id — not a new run.
    expect(result.reexecRunId).toBe(DEP_RUN);
    // (1) the branch was REBASED on the jj core (rebaseOnto invoked) — never a fresh clone.
    expect(h.workspace.rebaseCalls).toEqual([{ branch: DEP_BRANCH, baseSha: "sha-new-base" }]);
    // (1) the run row was KEPT: re-pointed + marked in-flight pointing at the SAME run. jj-local:
    // there is NO synthesized integration ref, so `runs.ancestor_stack` (the re-resolved stack)
    // is the sole base written.
    expect(h.persistence.repointStacks).toEqual([{ runId: DEP_RUN, ancestorStack: DEFAULT_STACK }]);
    expect(h.persistence.markedInFlight).toEqual([{ runId: DEP_RUN, ancestorSpecId: "spec_a", toSha: "sha-new" }]);
    // (1) re-plan was NOT invoked on a clean rebase + passing re-gate (tokens REUSED).
    expect(h.persistence.replanned).toEqual([]);
    // S0: the affected integration_nodes were consulted (observe-only).
    expect(h.nodes.calls).toBe(1);
  });

  it("a CLEAN rebase + passing re-gate emits integration.rebase `rebased_clean` (the rebase_vs_rebuild signal)", async () => {
    const h = harness({ conflictOnRebase: false, reGate: "passed" });
    await reexec(h);
    expect(h.events.events).toEqual([
      { runId: DEP_RUN, decision: "rebased_clean", rebaseConflicted: false, sameRunId: true },
    ]);
  });

  it("a CONFLICTED rebase RECORDS the jj conflict (work survives) + resolver fits ⇒ KEEP the run, NO re-plan", async () => {
    const h = harness({
      conflictOnRebase: true,
      reGate: "passed",
      resolution: { resolved: true, headSha: "sha-resolved" },
    });
    const result = await reexec(h);

    // The conflicting rebase SUCCEEDED + recorded the conflict (the work was not discarded).
    expect(h.workspace.rebaseCalls).toHaveLength(1);
    expect(h.resolver.calls).toBe(1);
    // The resolved tree fit (re-gate passed) ⇒ KEEP the run (same run id), NO re-plan.
    expect(result.reexecRunId).toBe(DEP_RUN);
    expect(h.persistence.repointStacks).toHaveLength(1);
    expect(h.persistence.replanned).toEqual([]);
    expect(h.events.events).toEqual([
      { runId: DEP_RUN, decision: "rebased_resolved", rebaseConflicted: true, sameRunId: true },
    ]);
  });

  it("a CONFLICTED rebase the resolver says is IRRECONCILABLE ⇒ re-plan (kept ALIVE, same run, NEVER discarded)", async () => {
    const h = harness({ conflictOnRebase: true, resolution: { resolved: false, reason: "intents genuinely collide" } });
    const result = await reexec(h);

    // Still the SAME run row — re-plan keeps the work alive on it, never a new run.
    expect(result.reexecRunId).toBe(DEP_RUN);
    expect(h.persistence.replanned).toHaveLength(1);
    expect(h.persistence.replanned[0]?.runId).toBe(DEP_RUN);
    // Never absorbed/kept-clean on an irreconcilable conflict.
    expect(h.persistence.markedInFlight).toEqual([]);
    expect(h.events.events).toEqual([
      { runId: DEP_RUN, decision: "replanned", rebaseConflicted: true, sameRunId: true },
    ]);
  });

  it("a CLEAN rebase whose re-gate FAILS a GATE TIER ⇒ WRITER REWORK (carrying the gate error), NOT replan/irreconcilable", async () => {
    const gateError = "base-shift re-gate failed at tier tier-2: step 'test' (exit 1)";
    const h = harness({ conflictOnRebase: false, reGate: "failed", reGateError: gateError });
    await reexec(h);
    expect(h.gateRework.calls).toEqual([{ specId: "spec_b", runId: DEP_RUN, gateError }]);
    expect(h.persistence.replanned).toEqual([]);
    expect(h.persistence.repointStacks).toEqual([]);
    const event = h.events.rawEvents[0];
    expect(event).toMatchObject({ decision: "replanned", rebaseConflicted: false, sameRunId: true });
    expect(() => IntegrationRebasePayload.parse(event)).not.toThrow();
  });

  it("Codex critic #15: a clean-rebase gate-fail ALWAYS routes to writer rework, NEVER to replan (no fallback)", async () => {
    const gateError = "base-shift re-gate failed at tier tier-3: step 'build' (exit 2)";
    const h = harness({ conflictOnRebase: false, reGate: "failed", reGateError: gateError });
    await reexec(h);
    expect(h.gateRework.calls).toEqual([{ specId: "spec_b", runId: DEP_RUN, gateError }]);
    expect(h.persistence.replanned).toEqual([]);
    expect(h.persistence.repointStacks).toEqual([]);
    const event = h.events.rawEvents[0];
    expect(event).toMatchObject({ decision: "replanned", rebaseConflicted: false, sameRunId: true });
    expect(() => IntegrationRebasePayload.parse(event)).not.toThrow();
  });

  it("a CONFLICTED rebase whose RESOLVED tree fails a GATE TIER ⇒ WRITER REWORK (clean tree, not irreconcilable)", async () => {
    // The resolver FIT the conflict (a clean resolved tree), but the coordinator's re-gate of
    // that resolved tree fails a GATE TIER — the tree is byte-clean, the code just fails a
    // gate on the new base. Route to WRITER REWORK, NOT replan.
    const gateError = "base-shift re-gate failed at tier tier-1: step 'lint' (exit 1)";
    const h = harness({
      conflictOnRebase: true,
      resolution: { resolved: true, headSha: "sha-resolved" },
      reGate: "failed",
      reGateError: gateError,
    });
    await reexec(h);
    expect(h.gateRework.calls).toEqual([{ specId: "spec_b", runId: DEP_RUN, gateError }]);
    expect(h.persistence.replanned).toEqual([]);
  });

  it("a CONFLICTED rebase whose resolver returned owned rework ⇒ NO double-route (no replan)", async () => {
    // The live resolver already routed writer rework and returns its exact owner receipt.
    // The coordinator MUST NOT also replan (that would double-route the spec).
    const h = harness({
      conflictOnRebase: true,
      resolution: {
        resolved: false,
        reason: "re-gate gate-tier fail — routed to rework",
        recovery: {
          kind: "owned",
          receipt: {
            kind: "writer_rework",
            specId: "spec_b",
            run: { kind: "enqueued", replanRunId: "run_rework", plannerTaskId: "task_rework" },
          },
        },
      },
    });
    await reexec(h);
    expect(h.persistence.replanned).toEqual([]);
    // The coordinator does not re-route (the resolver owned it) — its own gate-rework seam is
    // untouched on this path.
    expect(h.gateRework.calls).toEqual([]);
    expect(h.events.events).toEqual([
      { runId: DEP_RUN, decision: "replanned", rebaseConflicted: true, sameRunId: true },
    ]);
  });

  it("#1059 FAIL-CLOSED: a clean-rebase publish that REJECTS (stale `--force-with-lease`) HOLDS, never lands the stale head", async () => {
    // The live provider's `publishCleanRebase` force-pushes the rebased head with
    // `--force-with-lease=refs/heads/<head>:<fetched-sha>`. A reviewer/writer commit that moved
    // the remote head during the fetch→rebase→re-gate window makes the lease stale, so git
    // REJECTS the push and `pushJjHead` throws — which propagates OUT of the provider's
    // `rebaseOnto` (modelled here). The coordinator MUST map it to a fail-closed HOLD: never a
    // silent overwrite, and never a proceed-to-land on the stale head.
    const reject = new Error(
      "jj publish: push head failed: exit 1; stderr: ! [rejected] feat -> feat (stale info)",
    );
    const h = harness({ throwOnRebase: reject });
    await expect(reexec(h)).rejects.toBeInstanceOf(BaseShiftHeldError);
    // The work SURVIVES — the stale head was NEVER landed and NEVER replanned: just a loud hold.
    expect(h.persistence.repointStacks).toEqual([]); // no keep-run / land
    expect(h.persistence.markedInFlight).toEqual([]);
    expect(h.persistence.replanned).toEqual([]);
    // The re-gate never ran — we held BEFORE verifying/landing anything on the stale head.
    expect(h.reGate.calls).toBe(0);
    expect(h.events.events).toEqual([]);
  });

  it("FAIL-CLOSED: a `pending` (inconclusive) re-gate HOLDS — never merges, never discards", async () => {
    const h = harness({ conflictOnRebase: false, reGate: "pending" });
    await expect(reexec(h)).rejects.toBeInstanceOf(BaseShiftHeldError);
    // The work survives: no replan write, no keep-run write — just a loud hold.
    expect(h.persistence.replanned).toEqual([]);
    expect(h.persistence.repointStacks).toEqual([]);
  });

  it("non-speculative (every ancestor merged) re-points the base to an EMPTY stack (a real run against main), same run", async () => {
    const h = harness({ conflictOnRebase: false, reGate: "passed" });
    const result = await reexec(h, { nonSpeculative: true, ancestorStack: [] });
    expect(result.reexecRunId).toBe(DEP_RUN);
    // jj-local: non-speculative ⇒ the re-resolved stack is EMPTY (a real run against main).
    expect(h.persistence.repointStacks).toEqual([{ runId: DEP_RUN, ancestorStack: [] }]);
  });
});

describe("§5-P0 settle fix (tanren-owns-the-engine.md §5) — a changes_requested re-exec NEVER absorbs", () => {
  // The S1-plumbed review verdict is a FIRST-CLASS settle input: a `changes_requested`
  // re-exec must NOT advance the termination key / unblock the merge, even audited-clean.
  it("an audited-clean re-exec whose review verdict is changes_requested ⇒ REPLANNED (not absorbed)", () => {
    expect(decideSettle("audited", "none", "changes_requested")).toBe("replanned");
    expect(decideSettle("review", "none", "changes_requested")).toBe("replanned");
  });

  it("an APPROVED verdict does NOT over-block — an audited-clean re-exec still absorbs", () => {
    expect(decideSettle("audited", "none", "approved")).toBe("absorbed");
  });

  it("no verdict (no-review tier) does NOT block absorption on its own", () => {
    expect(decideSettle("audited", "none")).toBe("absorbed");
  });
});

// walker-jj-local-integration-design.md §2.2 — the never-discard base shift over the LOCAL
// ancestor stack. Two coupling points vs the deleted synthesized-ref path: (1) the
// coordinator THREADS the re-resolved ancestor stack to the opener (which assembles it
// locally); (2) `keepRun` re-points `runs.ancestor_stack` to the re-resolved stack (a run is
// "speculative" iff the stack is non-empty — the legacy `speculative_base` column is gone).
describe("base-shift over the re-resolved ancestor stack", () => {
  it("the re-resolved stack is THREADED to the opener (assembled locally, not a synthesized ref)", async () => {
    const h = harness({ conflictOnRebase: false, reGate: "passed" });
    await reexec(h);
    expect(h.opener.calls).toEqual([
      {
        runId: DEP_RUN,
        nonSpeculative: false,
        // The opener got the re-resolved stack (NOT undefined) — so the live opener assembles
        // it locally (`main + ordered ancestors`), never a synthesized host ref.
        ancestorStack: DEFAULT_STACK,
      },
    ]);
    // The dependent's branch was rebased onto the opener's assembled head (never-discard:
    // the SAME branch, rebased in place — not regenerated).
    expect(h.workspace.rebaseCalls).toEqual([{ branch: DEP_BRANCH, baseSha: "sha-new-base" }]);
  });

  it("keepRun re-points runs.ancestor_stack to the re-resolved stack (the sole base source)", async () => {
    const h = harness({ conflictOnRebase: false, reGate: "passed" });
    await reexec(h);
    expect(h.persistence.repointStacks).toEqual([{ runId: DEP_RUN, ancestorStack: DEFAULT_STACK }]);
  });

  it("every ancestor merged ⇒ the re-resolved stack is EMPTY (a real run against main)", async () => {
    const h = harness({ conflictOnRebase: false, reGate: "passed" });
    await reexec(h, { nonSpeculative: true, ancestorStack: [] });
    // Non-speculative: the opener gets an empty stack (it takes the plain default_branch
    // clone, not a local assembly) and keepRun writes an empty stack.
    expect(h.opener.calls).toEqual([{ runId: DEP_RUN, nonSpeculative: true, ancestorStack: [] }]);
    expect(h.persistence.repointStacks).toEqual([{ runId: DEP_RUN, ancestorStack: [] }]);
  });
});
