// SP-2 — conformance cases for the shared generalized authoring kernel
// (`createAuthoringKernel`). The adversarial matrix the contract enumerates
// (authoringKernel.ts `AuthoringKernelConformanceCase`): sequential isolation,
// previous-attempt feedback, signature-window recurrence, integer ceiling, bounded
// preview, non-throwing/non-mutating validator, persistence-throw → failed
// (non-propagating), deferred success, batch-fail/skip retract-BEFORE-failed with
// real attempt counts, exactly-one terminal per unit, and throw-safe emission.

import { describe, expect, it } from "vitest";
import { createAuthoringKernel } from "../src/engine/authoring/authoringKernelRunner.js";
import type {
  AuthoringBatchCompose,
  AuthoringEvents,
  AuthoringFamilyBinding,
  AuthoringPersistence,
  AuthoringSignatureDerivation,
  AuthoringValidationVerdict,
  AuthoringValidator,
} from "../src/engine/contracts/authoringKernel.js";

type Spec = string;
interface Draft {
  readonly body: string;
}
interface Validated {
  readonly value: string;
}
type LogEntry =
  | {
      readonly op: "event";
      readonly point: string;
      readonly unitId: string;
      readonly bodyPreview?: string;
      readonly attempts?: number;
    }
  | { readonly op: "delete"; readonly id: string }
  | { readonly op: "persist"; readonly id: string };
type Event = {
  readonly point: string;
  readonly unitId: string;
  readonly bodyPreview?: string;
  readonly attempts?: number;
};

const signatures: AuthoringSignatureDerivation<Draft> = {
  canonicalize: (draft) => `canon:${draft.body}`,
  sanitize: (rejection) => rejection.replaceAll(/\d{4}-\d\d-\d\dT[\d:.Z]+/gu, "<TS>"),
  preview: (draft) => draft.body,
};

function recorder() {
  const log: LogEntry[] = [];
  const events: AuthoringEvents<Spec, Draft, Validated, Event> = {
    factory: {
      build: ({ lifecycle }) => {
        const base: Event = { point: lifecycle.point, unitId: lifecycle.unitId };
        if (lifecycle.point === "attempt") return { ...base, bodyPreview: lifecycle.bodyPreview };
        if (lifecycle.point === "failed" || lifecycle.point === "succeeded")
          return { ...base, attempts: lifecycle.attempts };
        return base;
      },
    },
    sink: {
      emit: async (event) => {
        log.push({
          op: "event",
          point: event.point,
          unitId: event.unitId,
          ...(event.bodyPreview === undefined ? {} : { bodyPreview: event.bodyPreview }),
          ...(event.attempts === undefined ? {} : { attempts: event.attempts }),
        });
      },
    },
  };
  return { log, events };
}

/** An in-memory persistence recording persist/delete order into `log`. */
function memoryPersistence(log: LogEntry[]): AuthoringPersistence<Spec, Draft, Validated> {
  return {
    createValidated: async ({ spec }) => {
      const id = `persisted:${spec}`;
      log.push({ op: "persist", id });
      return { persistedId: id };
    },
    deleteById: async (id) => {
      log.push({ op: "delete", id });
    },
  };
}

const passBatch: AuthoringBatchCompose<Spec, Validated> = { compose: async () => ({ kind: "passed" }) };

function binding(
  over: Partial<AuthoringFamilyBinding<Spec, Draft, Validated, Event>>,
  log: LogEntry[],
  events: AuthoringEvents<Spec, Draft, Validated, Event>,
): AuthoringFamilyBinding<Spec, Draft, Validated, Event> {
  return {
    familyId: "ds-3",
    unitId: (spec) => `unit:${spec}`,
    authorer: { author: async ({ spec }) => ({ body: `body-${spec}` }) },
    validator: { validate: async ({ draft }) => ({ kind: "valid", validated: { value: draft.body } }) },
    persistence: memoryPersistence(log),
    batchCompose: passBatch,
    signatures,
    events,
    ...over,
  };
}

describe("authoring kernel — conformance", () => {
  it("sequential_failure_isolation: one failing unit does not stop the others", async () => {
    const { log, events } = recorder();
    const validator: AuthoringValidator<Spec, Draft, Validated> = {
      validate: async ({ spec, draft }) =>
        spec === "bad"
          ? { kind: "rejected", rejection: "always no" }
          : { kind: "valid", validated: { value: draft.body } },
    };
    const result = await createAuthoringKernel<Spec, Draft, Validated, Event>().run(
      { missing: ["bad", "good"], context: {} },
      binding({ validator, convergence: { iterationCeiling: 3, signatureWindowSize: 8 } }, log, events),
    );
    expect(result.validated).toEqual([{ value: "body-good" }]);
    expect(result.failedIds).toEqual(["unit:bad"]);
    // A constant body+rejection is a FIXED-POINT halt (the signature recurs) — the
    // failure reason is the last rejection, and the good unit still committed.
    expect(result.failureReasons["unit:bad"]).toBe("always no");
  });

  it("previous_attempt_feedback: the writer receives the prior draft + rejection", async () => {
    const { log, events } = recorder();
    const seen: (string | undefined)[] = [];
    let attempt = 0;
    const authorer = {
      author: async ({ previousAttempt }: { previousAttempt?: { draft?: Draft; rejection: string } }) => {
        seen.push(previousAttempt?.rejection);
        attempt += 1;
        return { body: `attempt-${attempt}` };
      },
    };
    let calls = 0;
    const validator: AuthoringValidator<Spec, Draft, Validated> = {
      validate: async ({ draft }) => {
        calls += 1;
        return calls === 1
          ? { kind: "rejected", rejection: "fix it" }
          : { kind: "valid", validated: { value: draft.body } };
      },
    };
    await createAuthoringKernel<Spec, Draft, Validated, Event>().run(
      { missing: ["x"], context: {} },
      binding({ authorer, validator }, log, events),
    );
    expect(seen).toEqual([undefined, "fix it"]);
  });

  it("signature_window_detects_recurrence: alternating rejection classes halt via the window, not the ceiling", async () => {
    const { log, events } = recorder();
    let n = 0;
    // Alternate between two bodies ⇒ two recurring signatures. With a window of 8 the
    // second recurrence is detected well before a ceiling of 100.
    const authorer = { author: async () => ({ body: n++ % 2 === 0 ? "A" : "B" }) };
    const validator: AuthoringValidator<Spec, Draft, Validated> = {
      validate: async ({ draft }) => ({ kind: "rejected", rejection: `reject-${draft.body}` }),
    };
    const result = await createAuthoringKernel<Spec, Draft, Validated, Event>().run(
      { missing: ["x"], context: {} },
      binding({ authorer, validator, convergence: { iterationCeiling: 100, signatureWindowSize: 8 } }, log, events),
    );
    expect(result.failedIds).toEqual(["unit:x"]);
    const failed = log.find((e) => e.op === "event" && e.point === "failed");
    // Halted at the fixed point (3rd attempt: A,B,A — A recurs), far below the ceiling.
    expect(failed?.op === "event" ? failed.attempts : undefined).toBeLessThan(10);
    expect(result.failureReasons["unit:x"]).not.toContain("iteration_ceiling_exceeded");
  });

  it("iteration_ceiling_is_integer_bound: a never-repeating writer halts at the exact integer count", async () => {
    const { log, events } = recorder();
    let n = 0;
    const authorer = { author: async () => ({ body: `unique-${n++}` }) };
    const validator: AuthoringValidator<Spec, Draft, Validated> = {
      validate: async () => ({ kind: "rejected", rejection: `unique-reject-${n}` }),
    };
    const result = await createAuthoringKernel<Spec, Draft, Validated, Event>().run(
      { missing: ["x"], context: {} },
      binding({ authorer, validator, convergence: { iterationCeiling: 5, signatureWindowSize: 8 } }, log, events),
    );
    expect(result.failureReasons["unit:x"]).toContain("iteration_ceiling_exceeded");
    const failed = log.find((e) => e.op === "event" && e.point === "failed");
    expect(failed?.op === "event" ? failed.attempts : undefined).toBe(5);
  });

  it("body_preview_is_bounded: the attempt event preview is truncated to 500 chars + ellipsis", async () => {
    const { log, events } = recorder();
    const big = "x".repeat(600);
    const authorer = { author: async () => ({ body: big }) };
    await createAuthoringKernel<Spec, Draft, Validated, Event>().run(
      { missing: ["x"], context: {} },
      binding({ authorer }, log, events),
    );
    const attempt = log.find((e) => e.op === "event" && e.point === "attempt");
    const preview = attempt?.op === "event" ? (attempt.bodyPreview ?? "") : "";
    expect(preview.length).toBe(501);
    expect(preview.endsWith("…")).toBe(true);
  });

  it("persistence_throw_is_failed_and_non_propagating", async () => {
    const { log, events } = recorder();
    const persistence: AuthoringPersistence<Spec, Draft, Validated> = {
      createValidated: async ({ spec }) => {
        if (spec === "boom") throw new Error("unique collision");
        return { persistedId: `persisted:${spec}` };
      },
      deleteById: async () => {},
    };
    const result = await createAuthoringKernel<Spec, Draft, Validated, Event>().run(
      { missing: ["boom", "ok"], context: {} },
      binding({ persistence }, log, events),
    );
    expect(result.failureReasons["unit:boom"]).toContain("persistence_failed");
    expect(result.validated).toEqual([{ value: "body-ok" }]);
  });

  it("success_is_deferred_until_batch_pass: no succeeded event before the batch gate", async () => {
    const { log, events } = recorder();
    await createAuthoringKernel<Spec, Draft, Validated, Event>().run(
      { missing: ["x"], context: {} },
      binding({}, log, events),
    );
    const persistIdx = log.findIndex((e) => e.op === "persist");
    const succeededIdx = log.findIndex((e) => e.op === "event" && e.point === "succeeded");
    expect(persistIdx).toBeGreaterThanOrEqual(0);
    expect(succeededIdx).toBeGreaterThan(persistIdx);
  });

  it("batch_failure_retracts_before_failed (real attempt count, no succeeded event)", async () => {
    const { log, events } = recorder();
    const failBatch: AuthoringBatchCompose<Spec, Validated> = {
      compose: async () => ({ kind: "failed", reason: "cross collide" }),
    };
    const result = await createAuthoringKernel<Spec, Draft, Validated, Event>().run(
      { missing: ["x"], context: {} },
      binding({ batchCompose: failBatch }, log, events),
    );
    expect(result.validated).toEqual([]);
    expect(result.failedIds).toEqual(["unit:x"]);
    const deleteIdx = log.findIndex((e) => e.op === "delete" && e.id === "persisted:x");
    const failedIdx = log.findIndex((e) => e.op === "event" && e.point === "failed");
    const succeeded = log.find((e) => e.op === "event" && e.point === "succeeded");
    expect(deleteIdx).toBeGreaterThanOrEqual(0);
    // retract BEFORE the terminal failed
    expect(failedIdx).toBeGreaterThan(deleteIdx);
    expect(succeeded).toBeUndefined();
    expect(result.failureReasons["unit:x"]).toContain("batch_compose_failed");
  });

  it("batch_skip_retracts_before_failed (no silent commit)", async () => {
    const { log, events } = recorder();
    const skipBatch: AuthoringBatchCompose<Spec, Validated> = {
      compose: async () => ({ kind: "skipped", reason: "unconfirmed" }),
    };
    const result = await createAuthoringKernel<Spec, Draft, Validated, Event>().run(
      { missing: ["x"], context: {} },
      binding({ batchCompose: skipBatch }, log, events),
    );
    expect(result.validated).toEqual([]);
    const deleteIdx = log.findIndex((e) => e.op === "delete");
    const failedIdx = log.findIndex((e) => e.op === "event" && e.point === "failed");
    expect(deleteIdx).toBeGreaterThanOrEqual(0);
    expect(failedIdx).toBeGreaterThan(deleteIdx);
    expect(result.failureReasons["unit:x"]).toContain("batch_compose_skipped");
  });

  it("terminal_event_is_exactly_once per unit across a mixed run", async () => {
    const { log, events } = recorder();
    const validator: AuthoringValidator<Spec, Draft, Validated> = {
      validate: async ({ spec, draft }) =>
        spec === "bad" ? { kind: "rejected", rejection: "no" } : { kind: "valid", validated: { value: draft.body } },
    };
    await createAuthoringKernel<Spec, Draft, Validated, Event>().run(
      { missing: ["bad", "good"], context: {} },
      binding({ validator, convergence: { iterationCeiling: 2, signatureWindowSize: 8 } }, log, events),
    );
    for (const unit of ["unit:bad", "unit:good"]) {
      const terminals = log.filter(
        (e) => e.op === "event" && (e.point === "succeeded" || e.point === "failed") && e.unitId === unit,
      );
      expect(terminals.length).toBe(1);
    }
  });

  it("event_emit_throw_is_non_propagating: a sink that always throws does not break the run", async () => {
    const { log } = recorder();
    const throwingEvents: AuthoringEvents<Spec, Draft, Validated, Event> = {
      factory: { build: () => ({ point: "x", unitId: "x" }) },
      sink: {
        emit: async () => {
          throw new Error("event store down");
        },
      },
    };
    const result = await createAuthoringKernel<Spec, Draft, Validated, Event>().run(
      { missing: ["x"], context: {} },
      binding({}, log, throwingEvents),
    );
    expect(result.validated).toEqual([{ value: "body-x" }]);
  });

  it("validator verdict, not throw: the kernel never sees a validator exception (contract)", async () => {
    // A conformant validator returns a rejected verdict; here we prove a valid
    // verdict flows through to a committed result via the real pass path.
    const { log, events } = recorder();
    const verdict: AuthoringValidationVerdict<Validated> = { kind: "valid", validated: { value: "ok" } };
    const validator: AuthoringValidator<Spec, Draft, Validated> = { validate: async () => verdict };
    const result = await createAuthoringKernel<Spec, Draft, Validated, Event>().run(
      { missing: ["x"], context: {} },
      binding({ validator }, log, events),
    );
    expect(result.validated).toEqual([{ value: "ok" }]);
  });
});
