// Spec-implementation loop integration tests (docs/roadmap/spec-loop-redesign.md).
// Each test wires the loop with in-memory adapters from helpers/plannerLoopHelpers
// and asserts on the event timeline + task-row shape produced by runSubtaskLoop. The
// suite covers the redesign's core: fast-gate-before-checker ordering, checker
// completeness-findings → writer, auditor findings-only + severity routing, triage
// P0→tasks / all-to-specs→pass, demo gating, and convergence-stall HALT (NOT a retry
// cap).
import { describe, expect, it } from "vitest";
import { runSubtaskLoop } from "../src/engine/workflow/subtaskLoop.js";
import { PersistentlyInvalidSpecError } from "../src/engine/forge/specQuality/index.js";
import { auditorReGateDecision } from "../src/engine/workflow/auditor/auditor.js";
import { decideCheckerOutcome } from "../src/engine/workflow/checker/checker.js";
import { routeTriageItems, summarizeTriageRouting } from "../src/engine/workflow/loopPolicy.js";
import { type ConvergencePolicyConfig, DEFAULT_CONVERGENCE_POLICY } from "../src/engine/config/shared.js";

// A convergence policy that overrides only the named fields over the redesign default
// (so a test states just the knob it exercises; the rest stay at today's behavior).
function convergencePolicyWith(overrides: Partial<ConvergencePolicyConfig>): ConvergencePolicyConfig {
  return { ...DEFAULT_CONVERGENCE_POLICY, ...overrides };
}
import {
  buildPlan,
  cleanAudit,
  completeCheck,
  convergenceProgress,
  convergenceStalled,
  convergenceVelocity,
  defaultLoopInput,
  demoBroken,
  demoClean,
  incompleteCheck,
  makeAuditor,
  makeChecker,
  makeConvergence,
  makeDemoRun,
  makeFailingWriter,
  makeGate,
  makePlanner,
  makeTriage,
  makeWriter,
  p0Audit,
  p1Audit,
  p2Audit,
  triageAllSpecs,
  triageAllTasks,
  triageMildTasks,
} from "./helpers/plannerLoopHelpers.js";

describe("spec loop — positive path", () => {
  it("dispatches subtasks in order and PASSES when checker + auditor are clean (no findings)", async () => {
    const { input, pool, events } = defaultLoopInput();
    const outcome = await runSubtaskLoop(input);

    expect(outcome.kind).toBe("passed");
    if (outcome.kind !== "passed") return;
    expect(outcome.loopCount).toBe(0);
    expect(outcome.subtasks).toHaveLength(1);
    expect(outcome.newSpecs).toHaveLength(0);

    // No findings ⇒ no triage / convergence ran (the clean exit).
    const taskKinds = pool.tasks.map((task) => task.kind);
    expect(taskKinds).toEqual(["plan", "write", "check", "audit"]);
    expect(taskKinds).not.toContain("triage");
    expect(taskKinds).not.toContain("convergence");

    const eventNames = events.events.map((event) => event.eventType);
    expect(eventNames).toContain("checker.verdict");
    expect(eventNames).toContain("auditor.verdict");
    const checkerVerdict = events.events.find((e) => e.eventType === "checker.verdict")!;
    expect(checkerVerdict.payload).toMatchObject({ complete: true, findings: [] });
    const auditorVerdict = events.events.find((e) => e.eventType === "auditor.verdict")!;
    expect(auditorVerdict.payload).toMatchObject({ findings: [] });
  });

  it("runs multiple subtasks in plan order, one writer task per subtask", async () => {
    const { input, events } = defaultLoopInput({
      adapters: {
        ...defaultLoopInput().input.adapters,
        planner: makePlanner([
          buildPlan([
            { title: "T1", intent: "A", behaviorIds: ["B1"] },
            { title: "T2", intent: "B", behaviorIds: ["B2"] },
            { title: "T3", intent: "C", behaviorIds: ["B3"] },
          ]),
        ]),
        writer: makeWriter(["a\n", "b\n", "c\n"]),
        checker: makeChecker([completeCheck, completeCheck, completeCheck]),
        auditor: makeAuditor([cleanAudit]),
      },
    });
    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("passed");
    const writes = events.events.filter((event) => event.eventType === "writer.subtask.completed");
    expect(writes.map((e) => (e.payload as { subtaskIndex: number }).subtaskIndex)).toEqual([0, 1, 2]);
  });
});

describe("spec loop — FAST GATE before CHECKER (ordering)", () => {
  it("runs the per_iteration gate BEFORE the checker; a gate fail loops to the writer without a checker call", async () => {
    // First per_iteration gate FAILS → straight back to writer (no checker). Second
    // per_iteration gate PASSES → checker runs (complete). The pre_audit spec gate passes.
    const gate = makeGate([{ passed: false }, { passed: true }, { passed: true }]);
    const checker = makeChecker([completeCheck]);
    const { input, pool } = defaultLoopInput({
      adapters: { ...defaultLoopInput().input.adapters, writer: makeWriter(["a\n", "b\n"]), checker },
      runGate: gate.gate,
    });
    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("passed");

    // The checker ran EXACTLY once — only after a passing fast gate (the first, failing
    // fast gate short-circuited to the writer before any checker call).
    expect(checker.calls).toHaveLength(1);
    // Two per_iteration gate calls (fail, pass) preceded the single pre_audit spec gate.
    const whens = gate.calls.map((c) => c.when);
    expect(whens).toEqual(["per_iteration", "per_iteration", "pre_audit"]);
    // Two writer attempts (the gate fail re-ran the writer), one checker.
    expect(pool.tasks.filter((t) => t.kind === "write")).toHaveLength(2);
    expect(pool.tasks.filter((t) => t.kind === "check")).toHaveLength(1);
  });
});

describe("spec loop — CHECKER findings route back to the WRITER", () => {
  it("an incomplete checker (any finding) re-runs the writer; a later complete check finishes the task", async () => {
    const checker = makeChecker([incompleteCheck, completeCheck]);
    const writer = makeWriter(["first\n", "second\n"]);
    const { input, events } = defaultLoopInput({
      adapters: { ...defaultLoopInput().input.adapters, checker, writer },
    });
    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("passed");

    // Two writer attempts (incomplete → rewrite), two checker calls.
    expect(writer.calls).toHaveLength(2);
    expect(checker.calls).toHaveLength(2);
    // The first checker verdict was incomplete; the second complete.
    const verdicts = events.events.filter((e) => e.eventType === "checker.verdict");
    expect((verdicts[0]!.payload as { complete: boolean }).complete).toBe(false);
    expect((verdicts[1]!.payload as { complete: boolean }).complete).toBe(true);
    // The rewrite prompt carried the prior incompleteness as steering.
    expect(writer.calls[1]!.prompt).toContain("Previous attempt was rejected");
  });

  it("a task that never completes within maxWriterIterPerSubtask becomes a P0 finding (NOT a halt)", async () => {
    // The checker stays incomplete every iteration. The task does NOT halt — its
    // residual incompleteness becomes a P0 finding routed into triage. We bound the test
    // by having triage route ALL to specs so the loop terminates with a PASS.
    const { input } = defaultLoopInput({
      escapeHatches: { maxWriterIterPerSubtask: 2 },
      adapters: {
        ...defaultLoopInput().input.adapters,
        writer: makeWriter(["a\n"]),
        checker: makeChecker([incompleteCheck]),
        triage: makeTriage([triageAllSpecs]),
      },
    });
    const outcome = await runSubtaskLoop(input);
    // It PASSES (the incompleteness was triaged into a new spec) — never halted on a cap.
    expect(outcome.kind).toBe("passed");
    if (outcome.kind !== "passed") return;
    expect(outcome.newSpecs.length).toBeGreaterThan(0);
  });
});

describe("spec loop — AUDITOR findings-only + deterministic severity routing", () => {
  it("a P0 audit finding routes to a task in this spec (triage→task), then converges", async () => {
    const { input, pool, events } = defaultLoopInput({
      adapters: {
        ...defaultLoopInput().input.adapters,
        // Loop 1: P0 audit → triage(task) → convergence(progress) → re-plan.
        // Loop 2: clean audit → PASS.
        auditor: makeAuditor([p0Audit, cleanAudit]),
        triage: makeTriage([triageAllTasks]),
        convergence: makeConvergence([convergenceProgress]),
      },
    });
    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("passed");

    // The triage + convergence stages ran on the first loop.
    expect(pool.tasks.some((t) => t.kind === "triage")).toBe(true);
    expect(pool.tasks.some((t) => t.kind === "convergence")).toBe(true);
    const triage = events.events.find((e) => e.eventType === "triage.completed")!;
    expect((triage.payload as { outcome: string }).outcome).toBe("kept");
    expect((triage.payload as { items: Array<{ route: string; severity: string }> }).items[0]).toMatchObject({
      route: "task",
      severity: "P0",
    });
  });

  it("auditorReGateDecision (used by the conflict re-gate) blocks on P0/P1, allows P2/P3 + clean", () => {
    expect(auditorReGateDecision(cleanAudit).blocked).toBe(false);
    expect(auditorReGateDecision(p2Audit).blocked).toBe(false);
    expect(auditorReGateDecision(p1Audit).blocked).toBe(true);
    expect(auditorReGateDecision(p0Audit).blocked).toBe(true);
  });
});

describe("spec loop — TRIAGE routing", () => {
  it("triage routing ALL findings to new specs PASSES the spec (triage→passed), no convergence", async () => {
    const { input, pool, events } = defaultLoopInput({
      adapters: {
        ...defaultLoopInput().input.adapters,
        auditor: makeAuditor([p1Audit]),
        triage: makeTriage([triageAllSpecs]),
      },
    });
    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("passed");
    if (outcome.kind !== "passed") return;
    // Every finding became a NEW spec; convergence never ran (the triage→passed arrow).
    expect(outcome.newSpecs).toHaveLength(1);
    expect(pool.tasks.some((t) => t.kind === "convergence")).toBe(false);
    const triage = events.events.find((e) => e.eventType === "triage.completed")!;
    expect((triage.payload as { outcome: string }).outcome).toBe("passed");
  });

  it("routeTriageItems: P0 always → task; below-threshold under route-to-dag → spec", () => {
    const items = [
      { id: "a", kind: "spec" as const, severity: "P0" as const, title: "t", body: "b", findingIds: [] },
      { id: "b", kind: "spec" as const, severity: "P3" as const, title: "t", body: "b", findingIds: [] },
    ];
    const routed = routeTriageItems(items, { blockReviewAt: "P1", p2p3Handling: "route-to-dag" });
    // P0 never defers; the below-threshold P3 routes to a new spec under velocity.
    expect(routed[0]!.route).toBe("task");
    expect(routed[1]!.route).toBe("spec");
    const summary = summarizeTriageRouting(routed);
    // A P0 task was kept in-spec, so the outcome is `kept`, not `passed`.
    expect(summary.outcome).toBe("kept");
  });
});

describe("spec loop — WS1↔WS2 spec-quality gate over triage's new specs", () => {
  const passAnswer = {
    accomplishable: { pass: true, reason: "bounded" },
    demoable: { pass: true, reason: "observable" },
    nonTrivial: { pass: true, reason: "worth a spec" },
    legible: { pass: true, reason: "clear" },
    overall: "pass" as const,
    revisionGuidance: "",
  };
  const reviseAnswer = {
    accomplishable: { pass: false, reason: "an unbounded epic" },
    demoable: { pass: false, reason: "no observable behavior" },
    nonTrivial: { pass: true, reason: "worth a spec" },
    legible: { pass: true, reason: "clear" },
    overall: "revise" as const,
    revisionGuidance: "split into a bounded, demo-able unit",
  };

  it("validates each kind:spec item against the contract and lets a PASSING spec through", async () => {
    const validated: Array<{ title: string }> = [];
    const { input } = defaultLoopInput({
      adapters: {
        ...defaultLoopInput().input.adapters,
        auditor: makeAuditor([p1Audit]),
        triage: makeTriage([triageAllSpecs]),
      },
      specValidator: {
        validator: {
          validate: (spec) => {
            validated.push({ title: spec.title });
            return Promise.resolve(passAnswer);
          },
        },
      },
    });
    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("passed");
    if (outcome.kind !== "passed") return;
    // The new spec materialized AND the gate ran on it (the seam is real, not a TODO).
    expect(outcome.newSpecs).toHaveLength(1);
    expect(validated).toHaveLength(1);
  });

  it("raises PersistentlyInvalidSpecError (loud) when a triaged spec fails the contract", async () => {
    const { input } = defaultLoopInput({
      adapters: {
        ...defaultLoopInput().input.adapters,
        auditor: makeAuditor([p1Audit]),
        triage: makeTriage([triageAllSpecs]),
      },
      // STRICT (no reviseSpec) → a first-pass failure escalates loud, never a silent commit.
      specValidator: { validator: { validate: () => Promise.resolve(reviseAnswer) } },
    });
    await expect(runSubtaskLoop(input)).rejects.toThrow(PersistentlyInvalidSpecError);
  });
});

describe("spec loop — DEMO-RUN gating (optional slot)", () => {
  it("when enabled, a broken demo emits findings that route through triage (gates the pass)", async () => {
    const { input, pool, events } = defaultLoopInput({
      convergencePolicy: convergencePolicyWith({ maxConsecutiveStalls: 3, demoRunEnabled: true }),
      adapters: {
        ...defaultLoopInput().input.adapters,
        // clean checker+auditor BUT a broken demo → triage(spec) → PASS with newSpecs.
        demoRun: makeDemoRun([demoBroken]),
        triage: makeTriage([triageAllSpecs]),
      },
    });
    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("passed");
    if (outcome.kind !== "passed") return;
    // The demo ran (the gating slot) and its finding reached triage.
    expect(pool.tasks.some((t) => t.kind === "demo")).toBe(true);
    expect(events.events.some((e) => e.eventType === "demoRun.verdict")).toBe(true);
    expect(outcome.newSpecs).toHaveLength(1);
  });

  it("when DISABLED (default), the demo slot does NOT run", async () => {
    const { input, pool } = defaultLoopInput();
    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("passed");
    expect(pool.tasks.some((t) => t.kind === "demo")).toBe(false);
  });

  it("a clean demo adds no findings (the spec still passes cleanly)", async () => {
    const { input } = defaultLoopInput({
      convergencePolicy: convergencePolicyWith({ maxConsecutiveStalls: 3, demoRunEnabled: true }),
      adapters: { ...defaultLoopInput().input.adapters, demoRun: makeDemoRun([demoClean]) },
    });
    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("passed");
    if (outcome.kind !== "passed") return;
    expect(outcome.newSpecs).toHaveLength(0);
  });
});

describe("spec loop — CONVERGENCE is the SOLE loop bound (stall HALT, NOT a retry cap)", () => {
  it("HALTS as convergence_stalled after N CONSECUTIVE stalls — never on a retry/timeout cap", async () => {
    // The auditor reports a P0 EVERY loop; triage keeps it in-spec; convergence STALLS
    // every loop. After maxConsecutiveStalls consecutive stalls, the run HALTS as
    // convergence_stalled. There is NO retry cap: the bound is the stall counter only.
    const maxConsecutiveStalls = 2;
    const { input, events } = defaultLoopInput({
      convergencePolicy: convergencePolicyWith({ maxConsecutiveStalls, demoRunEnabled: false }),
      adapters: {
        ...defaultLoopInput().input.adapters,
        auditor: makeAuditor([p0Audit]),
        triage: makeTriage([triageAllTasks]),
        convergence: makeConvergence([convergenceStalled]),
      },
    });
    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("convergence_stalled");
    if (outcome.kind !== "convergence_stalled") return;
    expect(outcome.consecutiveStalls).toBe(maxConsecutiveStalls);

    // The terminal convergence.stalled event was emitted, and exactly N convergence
    // stages ran (the loop iterated until the stall counter reached the bound).
    const stalled = events.events.find((e) => e.eventType === "convergence.stalled");
    expect(stalled?.payload).toMatchObject({ consecutiveStalls: maxConsecutiveStalls, maxConsecutiveStalls });
    const assessed = events.events.filter((e) => e.eventType === "convergence.assessed");
    expect(assessed).toHaveLength(maxConsecutiveStalls);
  });

  it("a velocity_defer convergence PASSES the spec, deferring the MILD (≤ default P3) leftovers as specs", async () => {
    // The kept leftover is P3 (`triageMildTasks`) — at-or-below the DEFAULT
    // velocityDeferMaxSeverity (P3), so the default velocity policy HONORS the defer.
    const { input, events } = defaultLoopInput({
      adapters: {
        ...defaultLoopInput().input.adapters,
        auditor: makeAuditor([p2Audit]),
        triage: makeTriage([triageMildTasks]),
        convergence: makeConvergence([convergenceVelocity]),
      },
    });
    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("passed");
    if (outcome.kind !== "passed") return;
    // The kept work was deferred as a new spec (velocity allow).
    expect(outcome.newSpecs.length).toBeGreaterThan(0);
    const assessed = events.events.find((e) => e.eventType === "convergence.assessed")!;
    expect((assessed.payload as { decision: string }).decision).toBe("pass");
  });

  it("a velocity_defer with leftovers ABOVE the configured max-severity is REFUSED (keeps iterating)", async () => {
    // The kept leftover is P0 (`triageAllTasks`), above the default P3 ceiling, so the
    // velocity defer is REFUSED — the loop iterates instead of passing. Here loop 2
    // then comes back clean, so the spec passes WITHOUT a velocity-defer.
    const { input, events } = defaultLoopInput({
      convergencePolicy: convergencePolicyWith({ maxConsecutiveStalls: 3 }),
      adapters: {
        ...defaultLoopInput().input.adapters,
        // Loop 1: P0 audit → kept-P0 → velocity_defer REFUSED → continue. Loop 2: clean.
        auditor: makeAuditor([p0Audit, cleanAudit]),
        triage: makeTriage([triageAllTasks]),
        convergence: makeConvergence([convergenceVelocity]),
      },
    });
    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("passed");
    if (outcome.kind !== "passed") return;
    // The defer was refused, so nothing was deferred as a new spec.
    expect(outcome.newSpecs).toHaveLength(0);
    const assessed = events.events.find((e) => e.eventType === "convergence.assessed")!;
    expect((assessed.payload as { decision: string }).decision).toBe("continue");
  });

  it("a PROGRESS convergence resets the stall counter and re-plans (no halt)", async () => {
    const { input } = defaultLoopInput({
      convergencePolicy: convergencePolicyWith({ maxConsecutiveStalls: 2, demoRunEnabled: false }),
      adapters: {
        ...defaultLoopInput().input.adapters,
        // Loop1: P0 → stalled. Loop2: P0 → PROGRESS (resets). Loop3: clean → PASS.
        auditor: makeAuditor([p0Audit, p0Audit, cleanAudit]),
        triage: makeTriage([triageAllTasks]),
        convergence: makeConvergence([convergenceStalled, convergenceProgress]),
      },
    });
    const outcome = await runSubtaskLoop(input);
    // Progress reset the stall counter, so a single prior stall never reached the bound.
    expect(outcome.kind).toBe("passed");
  });
});

describe("pure decisions", () => {
  it("decideCheckerOutcome: no findings ⇒ pass; any finding ⇒ reject with the gaps", () => {
    expect(decideCheckerOutcome(completeCheck)).toEqual({ kind: "pass" });
    const rejected = decideCheckerOutcome(incompleteCheck);
    expect(rejected.kind).toBe("reject");
    if (rejected.kind !== "reject") return;
    expect(rejected.behaviorIdsFailed).toEqual(["B1"]);
    expect(rejected.findings).toHaveLength(1);
  });

  it("decideCheckerOutcome: zero findings ⇒ PASS even on an empty incremental diff (criteria met by the committed tree)", () => {
    // EMPTY-INCREMENTAL-DIFF (v35): the bug — a re-driven/scaffold spec whose work is
    // already committed in the base has an EMPTY `baselineSha → HEAD` diff but the
    // criteria ARE met by the tree. Zero findings ⇒ PASS (accept) regardless of the
    // empty diff; `emptyIncrementalDiff` NEVER forces a reject or fabricates an accept.
    expect(decideCheckerOutcome(completeCheck, true)).toEqual({ kind: "pass" });
  });

  it("decideCheckerOutcome: a reject over an EMPTY diff is non-reworkable (the futile-rework guard); over a non-empty diff it stays reworkable", () => {
    // An empty-diff reject (criteria genuinely unmet by the tree, OR a stray
    // empty-diff finding) is NOT reworkable: re-driving the writer cannot grow an
    // empty diff, so the loop must route to triage instead of looping into
    // `persistent_failure`. A non-empty diff stays reworkable as before.
    const emptyDiffReject = decideCheckerOutcome(incompleteCheck, true);
    expect(emptyDiffReject.kind).toBe("reject");
    if (emptyDiffReject.kind !== "reject") return;
    expect(emptyDiffReject.reworkable).toBe(false);
    const nonEmptyReject = decideCheckerOutcome(incompleteCheck, false);
    expect(nonEmptyReject.kind).toBe("reject");
    if (nonEmptyReject.kind !== "reject") return;
    expect(nonEmptyReject.reworkable).toBe(true);
    // The default (no flag) is the non-empty-diff behaviour: reworkable.
    const defaulted = decideCheckerOutcome(incompleteCheck);
    expect(defaulted.kind === "reject" && defaulted.reworkable).toBe(true);
  });

  it("decideCheckerOutcome: a findings-omitted verdict throws (no `?? []` coalesce)", () => {
    const raw = { reasoning: "ok" } as unknown as typeof completeCheck;
    expect(() => decideCheckerOutcome(raw)).toThrow(/length|findings|undefined/iu);
  });

  it("decideCheckerOutcome: empty reasoning ⇒ reason is built from finding titles; null behaviorIds are dropped", () => {
    const verdict: typeof completeCheck = {
      reasoning: "",
      findings: [
        { id: "a", title: "missing endpoint", body: "b", behaviorId: "B1" },
        { id: "c", title: "missing migration", body: "b", behaviorId: null },
      ],
    };
    const decision = decideCheckerOutcome(verdict);
    expect(decision.kind).toBe("reject");
    if (decision.kind !== "reject") return;
    // The reason falls back to the joined finding titles when reasoning is empty.
    expect(decision.reason).toBe("missing endpoint; missing migration");
    // A null behaviorId is dropped from the downstream-blocked list.
    expect(decision.behaviorIdsFailed).toEqual(["B1"]);
  });

  // The pure `applyConvergencePolicy` decisions (incl. the configurable velocity
  // policy) live in loopPolicy.test.ts.
});

describe("spec loop — non-completing writer (never laundered to passed)", () => {
  it("a window_exhausted writer halts the run as window_exhausted; planner task not passed", async () => {
    const { input, pool } = defaultLoopInput({
      adapters: { ...defaultLoopInput().input.adapters, writer: makeFailingWriter("window_exhausted") },
    });
    const outcome = await runSubtaskLoop(input);
    expect(outcome.kind).toBe("window_exhausted");
    const planner = pool.tasks.find((t) => t.kind === "plan")!;
    expect(planner.outcome).toBe("window_exhausted");
    expect(pool.tasks.some((t) => t.kind === "check")).toBe(false);
  });
});
