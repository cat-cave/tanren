// Pins the WORKER-LEVEL classifier arms for the four typed errors landed by
// PRs #740 + #745. The stage-level classifier (`classifyStageFailureKind`) already
// covers these — but each error can throw BEFORE `runStageBodyWithFinalizeGuard`
// is entered, on the worker's context-hydration + design-oracle pre-row paths:
//
//   - MalformedAncestorStackError    → runExecutionContext.ts:159
//     (thrown during `loadRunContextScoped` — pre-stage)
//   - DesignContractCorruptError     → designWriterContext.ts:312
//     (thrown during design writer context load — pre-stage)
//   - DesignOracleActorConfigError   → designOracle.ts:185
//     (thrown BEFORE any store read / task row insert)
//   - MalformedDesignOracleResultError → designOracleLoopStage.ts:180
//     (thrown INSIDE the stage-body guard, but arms here for defense-in-depth so
//     the vocabulary stays complete if the guard is bypassed / removed)
//
// Without the worker-level arm, `classifyRunFailure` fell to the opaque `internal`
// default, hiding the typed diagnosis on `run.failed.failureCode`. This test locks
// each error class to its specific worker-level `{ code, stage, summary }` and
// re-pins the closed-vocabulary fallback so an unknown throw remains `internal`.

import { describe, expect, it } from "vitest";
import { MalformedAncestorStackError } from "../src/engine/dag/ancestorStack.js";
import { DesignContractCorruptError } from "../src/engine/repositories/designContracts.js";
import {
  DesignOracleActorConfigError,
  MalformedDesignOracleResultError,
} from "../src/engine/workflow/designOracle/designOracle.js";
import { classifyRunFailure, explicitRunFailureRetryability } from "../src/engine/worker/runFailureClassifier.js";
import { PersistentlyInvalidSpecError } from "../src/engine/forge/specQuality/index.js";
import {
  SimulatedReviewHeadStaleError,
  SimulatedReviewPublicationError,
} from "../src/engine/workflow/reviewMerge/simulatedReviewPublication.js";
import { SimulatedReviewPublishFenceBusyError } from "../src/engine/workflow/reviewMerge/simulatedReviewPublishFence.js";

describe("classifyRunFailure — typed-error arms for context-hydration + pre-row paths (Codex round-3 #3)", () => {
  it("maps MalformedAncestorStackError → malformed_ancestor_stack @ bootstrap", () => {
    // The `runs.ancestor_stack` jsonb failed schema parse during `loadRunContextScoped`
    // — a pre-stage throw the worker-level catch sees before any stage-body guard.
    const error = new MalformedAncestorStackError(
      [{ code: "invalid_type", path: ["0", "specId"], message: "expected string" } as never],
      { corrupt: "payload" },
    );
    expect(classifyRunFailure(error)).toEqual({
      code: "malformed_ancestor_stack",
      stage: "bootstrap",
      summary: "the run's ancestor stack failed schema parse",
    });
  });

  it("maps DesignContractCorruptError → design_contract_corrupt @ bootstrap", () => {
    // A `design_contracts` HEAD row failed `parseDesignContract` — the design writer
    // context loader throws this pre-stage rather than silently returning `undefined`
    // and making the corrupt row indistinguishable from "no design phase yet".
    const error = new DesignContractCorruptError("project_a", { corrupt: true }, "expected object at .foo");
    expect(classifyRunFailure(error)).toEqual({
      code: "design_contract_corrupt",
      stage: "bootstrap",
      summary: "the persisted design contract failed schema parse",
    });
  });

  it("maps DesignOracleActorConfigError → design_oracle_actor_config @ agent", () => {
    // The design oracle stage was invoked with a null-org actor — thrown BEFORE the
    // task row insert, so the stage-body guard never sees it and the worker-level
    // catch owns the classification.
    const error = new DesignOracleActorConfigError("project_a", "actor.orgId is null");
    expect(classifyRunFailure(error)).toEqual({
      code: "design_oracle_actor_config",
      stage: "agent",
      summary: "the design oracle actor is misconfigured",
    });
  });

  it("maps MalformedDesignOracleResultError → malformed_design_oracle_result @ agent", () => {
    // Post-answerer malformed result — captured by the stage-body guard AND by the
    // worker-level catch (defense-in-depth). The re-thrown class name flows through
    // so the worker-level `{ code, stage, summary }` matches the stage-level arm.
    const error = new MalformedDesignOracleResultError("missing/empty field(s): contractVersion");
    expect(classifyRunFailure(error)).toEqual({
      code: "malformed_design_oracle_result",
      stage: "agent",
      summary: "the design oracle result was malformed",
    });
  });

  it("BUG2 defense-in-depth: maps PersistentlyInvalidSpecError → spec_persistently_invalid @ agent (NOT internal)", () => {
    // apex v82: a triage-proposed spec's fixed-point rejection used to fall to the
    // opaque `internal` default and sink the whole run. With the triage-stage catch in
    // place this should not reach the run-level catch under autonomy:auto — but if it
    // escapes by another route (a genuinely-unfixable BUILD spec), the operator must
    // see a SPECIFIC needs_attention class, never opaque `internal`.
    const error = new PersistentlyInvalidSpecError(
      { title: "an unbounded epic", description: "d", acceptanceCriteria: [] },
      undefined,
      0,
    );
    const classified = classifyRunFailure(error);
    expect(classified.code).toBe("spec_persistently_invalid");
    expect(classified.code).not.toBe("internal");
    expect(classified).toEqual({
      code: "spec_persistently_invalid",
      stage: "agent",
      summary: "a spec could not be made valid and requires human attention",
    });
  });

  it("still falls closed to the generic `internal` code for an ordinary Error (no widening)", () => {
    // The new typed arms MUST NOT change how an unrecognized throw is surfaced —
    // an ordinary Error remains the safe `internal @ run` default so a novel secret
    // shape in the message can never widen what becomes public.
    expect(classifyRunFailure(new Error("some novel unclassified throw"))).toEqual({
      code: "internal",
      stage: "run",
      summary: "the run failed with an internal error",
    });
    expect(classifyRunFailure("a bare non-Error throw")).toEqual({
      code: "internal",
      stage: "run",
      summary: "the run failed with an internal error",
    });
    expect(classifyRunFailure(null)).toEqual({
      code: "internal",
      stage: "run",
      summary: "the run failed with an internal error",
    });
  });

  it("classifies strict publication failures safely and honors only their typed retry contract", () => {
    const permanent = new SimulatedReviewPublicationError("provider secret text");
    const busy = new SimulatedReviewPublishFenceBusyError("busy secret text");
    const stale = new SimulatedReviewHeadStaleError("a".repeat(40), "b".repeat(40));
    expect(classifyRunFailure(permanent)).toEqual({
      code: "merge",
      stage: "merge",
      summary: "strict simulated-review publication failed",
    });
    expect(explicitRunFailureRetryability(permanent)).toBe("non_retriable");
    expect(explicitRunFailureRetryability(busy)).toBe("retriable");
    expect(explicitRunFailureRetryability(stale)).toBe("retriable");
    const untrusted = Object.assign(new Error("not a publication error"), { retriable: true });
    expect(explicitRunFailureRetryability(untrusted)).toBeUndefined();
  });
});
