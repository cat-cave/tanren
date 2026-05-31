// Mutation ratchet (run-loop cluster): the planner / checker / auditor prompt
// builders are pure functions whose rendered text is the contract handed to the
// Codex Answerer. The baseline mutation run left almost every prompt line, every
// `|| "(none)"` fallback, and the empty-vs-populated branch unpinned (the loop
// tests only spot-checked a fragment). These tests render each prompt against a
// known spec and assert the EXACT lines + the fallback/branch behaviour, so a
// dropped instruction or a flipped fallback is caught. Behaviour-based: the
// observable artifact is the prompt string the adapter receives — asserted via
// a recording adapter for the invoke path and directly for the builders.
import { describe, expect, it } from "vitest";
import type { CheckAnswer, PlanAnswer } from "../src/engine/answerers/schemas/index.js";
import type { AnswererAdapter, AnswererRunOptions } from "../src/engine/providers/types.js";
import { buildAuditorPrompt, invokeAuditor } from "../src/engine/workflow/auditor/auditor.js";
import { buildCheckerPrompt, invokeChecker } from "../src/engine/workflow/checker/checker.js";
import { buildPlannerPrompt, invokePlanner } from "../src/engine/workflow/planner/planner.js";
import { passingAudit, passingCheck } from "./helpers/plannerLoopHelpers.js";

const subtask = (over: Partial<{ index: number; title: string; intent: string; behaviorIds: string[] }> = {}) => ({
  index: over.index ?? 0,
  title: over.title ?? "Wire the helper",
  intent: over.intent ?? "expose ok()",
  behaviorIds: over.behaviorIds ?? ["B1", "B2"],
  estimatedTokens: null,
});

describe("buildPlannerPrompt — full rendered contract", () => {
  const base = {
    timeoutMs: 1_000,
    rejectionHistory: [],
    spec: {
      specTitle: "Add status helpers",
      specDescription: "Implement ok() and fail().",
      acceptanceCriteria: ["AC-one: ok() exists", "AC-two: fail() exists"],
      behaviorIds: ["B1"],
      behaviorContext: [{ id: "B1", title: "ok exists", description: "module exports ok" }],
    },
  };

  it("renders the header instruction lines verbatim", () => {
    const prompt = buildPlannerPrompt(base);
    expect(prompt).toContain("You are the Tanren Planner Answerer. Decompose the spec into ordered subtasks.");
    expect(prompt).toContain("Return only the structured JSON required by the provided schema.");
    expect(prompt).toContain("Do not edit files, run mutation commands, create commits, or write to the workspace.");
  });

  it("renders the spec title, description, and each acceptance criterion as a bullet", () => {
    const prompt = buildPlannerPrompt(base);
    expect(prompt).toContain("Spec title: Add status helpers");
    expect(prompt).toContain("Spec description: Implement ok() and fail().");
    expect(prompt).toContain("Acceptance criteria:");
    expect(prompt).toContain("- AC-one: ok() exists");
    expect(prompt).toContain("- AC-two: fail() exists");
  });

  it("renders declared behaviors with id, title, and description when present", () => {
    const prompt = buildPlannerPrompt(base);
    expect(prompt).toContain("Declared behaviors (refer to these by id in subtasks.behaviorIds):");
    expect(prompt).toContain("- B1: ok exists — module exports ok");
    // The empty-behaviors branch text must NOT appear when behaviors exist.
    expect(prompt).not.toContain("Behaviors: none declared.");
  });

  it("renders the none-declared branch when behaviorContext is empty", () => {
    const prompt = buildPlannerPrompt({ ...base, spec: { ...base.spec, behaviorContext: [] } });
    expect(prompt).toContain("Behaviors: none declared.");
    expect(prompt).not.toContain("Declared behaviors (refer to these by id in subtasks.behaviorIds):");
  });

  it("renders the first-plan rejection line when history is empty", () => {
    const prompt = buildPlannerPrompt(base);
    expect(prompt).toContain("This is the first plan for the spec — no prior rejections.");
    expect(prompt).not.toContain("Prior rejections");
    // The first-plan line is followed by a blank-line separator, then the footer.
    expect(prompt).toContain(
      "no prior rejections.\n\nEvery subtask MUST be an actionable change that modifies the workspace and",
    );
  });

  it("separates the header / behaviors / rejection blocks with blank lines (separator pins)", () => {
    const prompt = buildPlannerPrompt(base);
    // no-write instruction → blank → spec title.
    expect(prompt).toContain("write to the workspace.\n\nSpec title: Add status helpers");
    // header → criteria bullets → blank → behaviors block.
    expect(prompt).toContain("- AC-two: fail() exists\n\nDeclared behaviors");
    // behaviors block → blank → rejection block.
    expect(prompt).toContain("- B1: ok exists — module exports ok\n\nThis is the first plan");
  });

  it("renders every footer requirement line", () => {
    const prompt = buildPlannerPrompt(base);
    expect(prompt).toContain("Emit at least one subtask. Each subtask must declare:");
    expect(prompt).toContain("- index: 0-based position in the execution order");
    expect(prompt).toContain("- title: short human-readable label");
    expect(prompt).toContain("- intent: declared rationale for this subtask");
    expect(prompt).toContain("- behaviorIds: subset of declared behavior ids this subtask satisfies");
    expect(prompt).toContain("- estimatedTokens: integer estimate or null when unknown");
    expect(prompt).toContain("Provide a top-level rationale explaining the decomposition.");
  });

  it("renders the rejection history block with producer, reason, failed ids, and prior subtasks", () => {
    const prompt = buildPlannerPrompt({
      ...base,
      rejectionHistory: [
        {
          producer: "auditor",
          rejectionReason: "missing fail() coverage",
          behaviorIdsFailed: ["B2", "B3"],
          previousSubtasks: [
            { index: 0, title: "old", intent: "old intent", behaviorIds: ["B1"], estimatedTokens: null },
          ],
        },
      ],
    });
    expect(prompt).toContain("Prior rejections — address every outstanding behavior id in the new plan:");
    expect(prompt).toContain("Rejection #1 from auditor:");
    expect(prompt).toContain("  reason: missing fail() coverage");
    expect(prompt).toContain("  behaviorIdsFailed: B2, B3");
    expect(prompt).toContain("  prior subtasks:");
    expect(prompt).toContain("    [0] old — old intent");
    // The "Prior rejections" header is followed by a blank line, then the first
    // rejection entry; and the rejection block ends with a blank-line separator
    // before the footer. Exact adjacency pins those separators.
    expect(prompt).toContain("the new plan:\n\nRejection #1 from auditor:");
    expect(prompt).toContain(
      "    [0] old — old intent\n\nEvery subtask MUST be an actionable change that modifies the workspace and",
    );
  });

  it("falls back to (none reported) when a rejection lists no failed behavior ids", () => {
    const prompt = buildPlannerPrompt({
      ...base,
      rejectionHistory: [
        { producer: "gate", rejectionReason: "build failed", behaviorIdsFailed: [], previousSubtasks: [] },
      ],
    });
    expect(prompt).toContain("  behaviorIdsFailed: (none reported)");
  });
});

describe("buildCheckerPrompt — full rendered contract", () => {
  const ctx = {
    specTitle: "Spec X",
    specDescription: "Do the thing.",
    acceptanceCriteria: ["AC1: file exists", "AC2: wired"],
    subtask: subtask(),
    writerDiff: "diff --git a/x b/x\n+ok\n",
  };

  it("renders the intent-only role framing and the hard boundaries verbatim", () => {
    const prompt = buildCheckerPrompt(ctx);
    // Each continuation line of the multi-line role framing + boundaries is its
    // own array element, so assert a unique fragment of every one.
    expect(prompt).toContain("You are the Tanren Checker Answerer. Your ONLY job is to judge intent");
    expect(prompt).toContain("satisfaction: does the writer diff fulfil the subtask intent and each");
    expect(prompt).toContain("explicit acceptance criterion in the spec? Judge by reading the diff and");
    expect(prompt).toContain("the spec — nothing else.");
    expect(prompt).toContain("Hard boundaries (a separate deterministic gate, not you, owns correctness):");
    expect(prompt).toContain("- Do NOT run, simulate, invoke, or shell out to tests, builds, type checks,");
    expect(prompt).toContain("  linters, or any command. The workspace may be unbuilt; that is expected");
    expect(prompt).toContain("  and is NOT your concern.");
    expect(prompt).toContain("- Do NOT assert, claim, predict, or report whether tests/build/lint pass or");
    expect(prompt).toContain("  fail. A separate in-loop deterministic gate verifies correctness; never");
    expect(prompt).toContain("  base your verdict on it or speculate about its result.");
    expect(prompt).toContain("- Do NOT edit files, run mutation commands, create commits, or write to the");
    expect(prompt).toContain("  workspace.");
    expect(prompt).toContain("- Judge intent only. 'The code looks like it might fail to compile/test' is");
    expect(prompt).toContain("  out of scope: if the intent and criteria are addressed by the diff, that");
    expect(prompt).toContain("  satisfies you.");
    expect(prompt).toContain("- An acceptance criterion that is INHERENTLY a test/build/lint OUTCOME (e.g.");
    expect(prompt).toContain("  criterion as DEFERRED — note it in `reasoning` as gate-owned, and do NOT");
    expect(prompt).toContain("  the diff implements the behavior such a test would exercise.");
    expect(prompt).toContain("Return only the structured JSON required by the provided schema.");
  });

  it("renders the spec, each acceptance criterion bullet, and the subtask fields", () => {
    const prompt = buildCheckerPrompt(ctx);
    expect(prompt).toContain("Spec title: Spec X");
    expect(prompt).toContain("Spec description: Do the thing.");
    expect(prompt).toContain("Explicit acceptance criteria (judge each one):");
    expect(prompt).toContain("- AC1: file exists");
    expect(prompt).toContain("- AC2: wired");
    expect(prompt).toContain("Subtask [0]: Wire the helper");
    expect(prompt).toContain("Subtask intent: expose ok()");
    expect(prompt).toContain("Subtask behavior ids: B1, B2");
  });

  it("renders the verdict-instruction lines and embeds the writer diff", () => {
    const prompt = buildCheckerPrompt(ctx);
    expect(prompt).toContain("In `reasoning`, cite each acceptance criterion / behavior by name and state");
    expect(prompt).toContain("whether the diff satisfies its intent and why (marking any test/build/lint-");
    expect(prompt).toContain("outcome criterion as gate-deferred). Set passed=true when the subtask intent");
    expect(prompt).toContain("and every diff-assessable acceptance criterion are satisfied by the diff;");
    expect(prompt).toContain("gate-deferred outcome criteria must not block a pass. Always populate");
    expect(prompt).toContain("behaviorIdsPassed and behaviorIdsFailed (use empty arrays when none),");
    expect(prompt).toContain("reflecting intent satisfaction — not test/build outcomes.");
    expect(prompt).toContain("Writer diff:");
    expect(prompt).toContain("diff --git a/x b/x\n+ok\n");
  });

  it("falls back to (none) for the subtask behavior ids when empty", () => {
    const prompt = buildCheckerPrompt({ ...ctx, subtask: subtask({ behaviorIds: [] }) });
    expect(prompt).toContain("Subtask behavior ids: (none)");
  });

  it("separates each block with a blank line (separator pins)", () => {
    const prompt = buildCheckerPrompt(ctx);
    expect(prompt).toContain("the spec — nothing else.\n\nHard boundaries");
    expect(prompt).toContain(
      "  the diff implements the behavior such a test would exercise.\n\nReturn only the structured JSON required by the provided schema.",
    );
    expect(prompt).toContain("- AC2: wired\n\nSubtask [0]: Wire the helper");
    expect(prompt).toContain("Subtask behavior ids: B1, B2\n\nIn `reasoning`,");
    expect(prompt).toContain("not test/build outcomes.\n\nWriter diff:");
  });
});

describe("buildAuditorPrompt — full rendered contract", () => {
  const ctx = {
    specTitle: "Spec Y",
    specDescription: "Audit the work.",
    acceptanceCriteria: ["AC1: all helpers exist"],
    subtasks: [
      subtask({ index: 0, title: "S0", intent: "i0", behaviorIds: ["B1"] }),
      subtask({ index: 1, title: "S1", intent: "i1", behaviorIds: [] }),
    ],
    combinedDiff: "diff a\ndiff b\n",
  };

  it("renders the role framing and the no-write boundary verbatim", () => {
    const prompt = buildAuditorPrompt(ctx);
    expect(prompt).toContain(
      "You are the Tanren Auditor Answerer. Audit whether the executed subtask plan satisfies the spec.",
    );
    expect(prompt).toContain("Return only the structured JSON required by the provided schema.");
    expect(prompt).toContain("Do not edit files, run mutation commands, create commits, or write to the workspace.");
  });

  it("renders the spec, criteria, and each executed subtask line", () => {
    const prompt = buildAuditorPrompt(ctx);
    expect(prompt).toContain("Spec title: Spec Y");
    expect(prompt).toContain("Spec description: Audit the work.");
    expect(prompt).toContain("Acceptance criteria:");
    expect(prompt).toContain("- AC1: all helpers exist");
    expect(prompt).toContain("Executed subtasks:");
    expect(prompt).toContain("- [0] S0 (intent: i0, behaviors: B1)");
  });

  it("falls back to (none) for a subtask with no behaviors and renders other subtasks normally", () => {
    const prompt = buildAuditorPrompt(ctx);
    expect(prompt).toContain("- [1] S1 (intent: i1, behaviors: (none))");
  });

  it("renders the pass/loop/halt recommendation rules and embeds the combined diff", () => {
    const prompt = buildAuditorPrompt(ctx);
    expect(prompt).toContain(
      "Set passed=true only when every acceptance criterion is satisfied by the combined writer diff.",
    );
    expect(prompt).toContain("Set recommendedAction='pass' when passed=true.");
    expect(prompt).toContain("Set recommendedAction='loop_to_planner' when the spec is recoverable by re-planning.");
    expect(prompt).toContain("Set recommendedAction='halt' when the spec is not recoverable in this run.");
    expect(prompt).toContain("Combined writer diff:");
    expect(prompt).toContain("diff a\ndiff b\n");
  });

  it("separates each block with a blank line (exact adjacency pins the separators)", () => {
    const prompt = buildAuditorPrompt(ctx);
    // Blank-line separators between the no-write line/spec, criteria/executed,
    // subtasks/rules, and rules/diff. Exact "\n\n" adjacency catches a separator
    // turned into spurious text.
    expect(prompt).toContain("write to the workspace.\n\nSpec title: Spec Y");
    expect(prompt).toContain("- AC1: all helpers exist\n\nExecuted subtasks:");
    expect(prompt).toContain("behaviors: (none))\n\nSet passed=true only when");
    expect(prompt).toContain("not recoverable in this run.\n\nCombined writer diff:");
  });
});

// The invoke* functions pass the built prompt, the timeout, the workspace, and
// the canonical output schema through to the adapter and return the schema id.
// A recording adapter pins those argument values so the object-literal mutant
// at the runAnswerer call site (and the schema-name return) is killed.
function recordingChecker(): AnswererAdapter<CheckAnswer> & { last?: AnswererRunOptions<CheckAnswer> } {
  const adapter: AnswererAdapter<CheckAnswer> & { last?: AnswererRunOptions<CheckAnswer> } = {
    kind: "answerer",
    cli: "fake",
    authRef: "credential/self-hosted/tanren-fake",
    async runAnswerer(opts) {
      adapter.last = opts;
      return passingCheck;
    },
  };
  return adapter;
}

describe("invoke* forwards prompt, timeout, workspace, and the canonical schema", () => {
  it("invokeChecker forwards the built prompt + timeout + workspace and reports the check schema id", async () => {
    const adapter = recordingChecker();
    const result = await invokeChecker(adapter, {
      context: {
        specTitle: "S",
        specDescription: "D",
        acceptanceCriteria: ["AC1"],
        subtask: subtask(),
        writerDiff: "diff\n",
      },
      timeoutMs: 4_242,
      workspace: "/ws/repo",
    });
    expect(adapter.last?.timeoutMs).toBe(4_242);
    expect(adapter.last?.workspace).toBe("/ws/repo");
    expect(adapter.last?.prompt).toContain("You are the Tanren Checker Answerer");
    expect(adapter.last?.outputSchema.name).toBe(result.schemaId);
    expect(result.schemaId).toContain("check");
  });

  it("invokePlanner forwards prompt + timeout + workspace and returns the plan + schema id", async () => {
    let seen: AnswererRunOptions<PlanAnswer> | undefined;
    const plan: PlanAnswer = { rationale: "r", subtasks: [subtask()] };
    const adapter: AnswererAdapter<PlanAnswer> = {
      kind: "answerer",
      cli: "fake",
      authRef: "credential/self-hosted/tanren-fake",
      async runAnswerer(opts) {
        seen = opts;
        return plan;
      },
    };
    const result = await invokePlanner(adapter, {
      spec: {
        specTitle: "S",
        specDescription: "D",
        acceptanceCriteria: ["AC1"],
        behaviorIds: [],
        behaviorContext: [],
      },
      timeoutMs: 9_001,
      rejectionHistory: [],
      workspace: "/ws/plan",
    });
    expect(seen?.timeoutMs).toBe(9_001);
    expect(seen?.workspace).toBe("/ws/plan");
    expect(seen?.prompt).toContain("You are the Tanren Planner Answerer");
    expect(result.plan).toBe(plan);
    expect(result.schemaId).toContain("plan");
  });

  it("invokeAuditor forwards prompt + timeout + workspace and reports the audit schema id", async () => {
    let seen: AnswererRunOptions<typeof passingAudit> | undefined;
    const adapter: AnswererAdapter<typeof passingAudit> = {
      kind: "answerer",
      cli: "fake",
      authRef: "credential/self-hosted/tanren-fake",
      async runAnswerer(opts) {
        seen = opts;
        return passingAudit;
      },
    };
    const result = await invokeAuditor(adapter, {
      context: {
        specTitle: "S",
        specDescription: "D",
        acceptanceCriteria: ["AC1"],
        subtasks: [subtask()],
        combinedDiff: "diff\n",
      },
      timeoutMs: 7_777,
      workspace: "/ws/audit",
    });
    expect(seen?.timeoutMs).toBe(7_777);
    expect(seen?.workspace).toBe("/ws/audit");
    expect(seen?.prompt).toContain("You are the Tanren Auditor Answerer");
    expect(result.schemaId).toContain("audit");
  });
});
