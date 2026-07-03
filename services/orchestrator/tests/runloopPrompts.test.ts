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
import { cleanAudit, completeCheck } from "./helpers/plannerLoopHelpers.js";

const subtask = (over: Partial<{ index: number; title: string; intent: string; behaviorIds: string[] }> = {}) => ({
  index: over.index ?? 0,
  title: over.title ?? "Wire the helper",
  intent: over.intent ?? "expose ok()",
  behaviorIds: over.behaviorIds ?? ["B1", "B2"],
  estimatedTokens: null,
});

describe("buildPlannerPrompt — full rendered contract", () => {
  const base = {
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
    // behaviors block → blank → grading-criteria block (spec-loop redesign §PLANNER).
    expect(prompt).toContain("- B1: ok exists — module exports ok\n\nHow the resulting work is graded");
    // grading-criteria block → blank → subtask-sizing block (apex-v76 mega-intent fix).
    expect(prompt).toContain("produce that observable behavior so the demo can exercise it.\n\nSUBTASK SIZING RULE:");
    // subtask-sizing block → blank → rejection block.
    expect(prompt).toContain(
      "unrelated surfaces or introduce multiple new endpoints/pages, split it.\n\nThis is the first plan",
    );
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

  // apex-v76 mega-intent fix: v76's spec (a link-shortener) got wedged when the planner
  // emitted a SINGLE subtask bundling four product concerns (shortener form + redirect
  // route + analytics page + Slack handler). The writer stalled on that mega-intent 20+
  // times because a single Codex CLI call could not finish four concerns before its
  // sign-of-life window elapsed. The FIX is at the planner prompt: explicit guidance
  // that each subtask must touch exactly ONE concern, with concrete good/bad examples.
  // Assert every line of that steering renders so a drift catches this class of stall.
  it("renders the apex-v76 SUBTASK SIZING RULE — one concern per subtask, no bundling", () => {
    const prompt = buildPlannerPrompt(base);
    // The rule opener + core constraint.
    expect(prompt).toContain("SUBTASK SIZING RULE: each subtask must touch exactly ONE concern that a single");
    expect(prompt).toContain("writer call can complete before the sign-of-life window.");
    // The "emit multiple subtasks — one per concern" directive, quoting v76's concerns.
    expect(prompt).toContain("If a spec describes");
    expect(prompt).toContain("multiple product concerns (e.g. 'shorten form + redirect route + analytics page");
    expect(prompt).toContain("+ Slack handler'), emit MULTIPLE subtasks — one per concern. Do NOT bundle");
    // The good-example list (one concern per bullet) that the planner should model.
    expect(prompt).toContain("Examples of ONE concern (good subtasks):");
    expect(prompt).toContain("- 'Add a URL shortener form + shorten action + result display + copy button'");
    expect(prompt).toContain("- 'Add the /r/<slug> redirect route + click counter increment'");
    expect(prompt).toContain("- 'Add a passcode-protected owner analytics view + per-link click count list'");
    expect(prompt).toContain("- 'Add Slack milestone handling: on 100-click, post one message'");
    // The bad-example list (the exact v76 mega-intent shape) that the planner MUST NOT emit.
    expect(prompt).toContain("Examples of a TOO-BIG subtask (BAD — do NOT emit):");
    expect(prompt).toContain(
      "- 'Implement the entire URL shortener + redirect + analytics + Slack handler' (four concerns)",
    );
    expect(prompt).toContain("- 'Build the whole feature end-to-end' (unbounded)");
    // The split criterion (LOC ballpark + surfaces/endpoints heuristic).
    expect(prompt).toContain("A concern maps to ~50-500 LOC of change.");
    expect(prompt).toContain("If a subtask would touch multiple files");
    expect(prompt).toContain("across unrelated surfaces or introduce multiple new endpoints/pages, split it.");
  });

  it("places the SUBTASK SIZING RULE between the grading-criteria block and the rejection block", () => {
    const prompt = buildPlannerPrompt(base);
    // The sizing rule follows the grading-criteria block (spec-loop redesign) so the
    // planner sees the sizing constraint alongside the grading-bar guidance.
    expect(prompt).toContain("produce that observable behavior so the demo can exercise it.\n\nSUBTASK SIZING RULE:");
    // The sizing rule precedes the first-plan rejection line — the sizing rule steers
    // the initial decomposition, not just re-plans after rejection.
    expect(prompt).toContain(
      "unrelated surfaces or introduce multiple new endpoints/pages, split it.\n\nThis is the first plan",
    );
  });
});

describe("buildCheckerPrompt — full rendered contract", () => {
  const baselineSha = "a".repeat(40);
  const ctx = {
    specTitle: "Spec X",
    specDescription: "Do the thing.",
    acceptanceCriteria: ["AC1: file exists", "AC2: wired"],
    subtask: subtask(),
    baselineSha,
  };

  it("renders the intent-only role framing and the hard boundaries verbatim", () => {
    const prompt = buildCheckerPrompt(ctx);
    // Each continuation line of the multi-line role framing + boundaries is its
    // own array element, so assert a unique fragment of every one.
    expect(prompt).toContain("You are the Tanren Checker Answerer. Your ONLY job is to judge COMPLETENESS for");
    expect(prompt).toContain("downstream tasks: does the writer's change deliver the subtask intent and each");
    expect(prompt).toContain("explicit acceptance criterion that LATER tasks build on? Judge by reading the");
    expect(prompt).toContain("change and the spec — nothing else. Emit a completeness finding per incompleteness.");
    // The self-inspection instruction + baseline sha replace the injected diff.
    expect(prompt).toContain("The writer's change is committed on the current branch of your read-only");
    expect(prompt).toContain("Inspect it yourself: run");
    expect(prompt).toContain(`git diff ${baselineSha} -- . ':(exclude)node_modules'`);
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
    expect(prompt).toContain("  emit a finding for it. You verify only that the diff implements the behavior");
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

  it("renders the completeness-findings output instructions and embeds no diff payload", () => {
    const prompt = buildCheckerPrompt(ctx);
    // SPEC-LOOP REDESIGN: the checker emits completeness findings (no binary passed).
    expect(prompt).toContain("Emit your answer as a `findings` list — one entry per concrete way THIS task is");
    expect(prompt).toContain("not yet complete for what DOWNSTREAM tasks build on. Every such finding is");
    expect(prompt).toContain("blocking (treated as P0): nothing about delivering a task another task depends on");
    expect(prompt).toContain("`findings` list when the task is complete for downstream needs — never invent a");
    expect(prompt).toContain("judgment — the loop decides complete-vs-incomplete from your findings.");
    // No diff is injected — the agent reads it from the workspace itself.
    expect(prompt).not.toContain("Writer diff:");
    expect(prompt).not.toContain("diff --git");
  });

  it("falls back to (none) for the subtask behavior ids when empty", () => {
    const prompt = buildCheckerPrompt({ ...ctx, subtask: subtask({ behaviorIds: [] }) });
    expect(prompt).toContain("Subtask behavior ids: (none)");
  });

  it("separates each block with a blank line (separator pins)", () => {
    const prompt = buildCheckerPrompt(ctx);
    // The self-inspection block ends with the optional sem-accelerator's fallback
    // line (entity-analysis-layer §2.2), then the EMPTY-DIFF rule block (v35), then
    // the Hard-boundaries block.
    expect(prompt).toContain("Never block or change your verdict because `sem` is unavailable.\n\nEMPTY-DIFF RULE:");
    expect(prompt).toContain("emit an EMPTY findings list (the task is complete).\n\nHard boundaries");
    expect(prompt).toContain(
      "such a test would exercise.\n\nReturn only the structured JSON required by the provided schema.",
    );
    expect(prompt).toContain("- AC2: wired\n\nSubtask [0]: Wire the helper");
    expect(prompt).toContain("Subtask behavior ids: B1, B2\n\nEmit your answer as a `findings` list");
    // The prompt ends on the completeness-findings instruction block — no trailing diff.
    expect(prompt.trimEnd().endsWith("the loop decides complete-vs-incomplete from your findings.")).toBe(true);
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
    baselineSha: "b".repeat(40),
  };

  it("renders the role framing and the no-write boundary verbatim", () => {
    const prompt = buildAuditorPrompt(ctx);
    expect(prompt).toContain(
      "You are the Tanren Auditor Answerer. Audit whether the executed subtask plan satisfies the spec.",
    );
    expect(prompt).toContain("Return only the structured JSON required by the provided schema.");
    expect(prompt).toContain("Do not edit files, run mutation commands, create commits, or write to the workspace.");
    // The self-inspection instruction + baseline sha replace the injected diff.
    expect(prompt).toContain("Inspect it yourself: run");
    expect(prompt).toContain(`git diff ${"b".repeat(40)} -- . ':(exclude)node_modules'`);
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

  it("renders the findings-only emission instruction and embeds no diff payload (S3)", () => {
    const prompt = buildAuditorPrompt(ctx);
    // S3: the auditor emits FINDINGS only — no pass/recommendedAction instructions.
    expect(prompt).toContain("Emit your audit as a `findings` list");
    expect(prompt).toContain("EXPLICIT severity: P0");
    expect(prompt).toContain("NOT render a pass/fail/halt judgment yourself");
    expect(prompt).not.toContain("Set recommendedAction=");
    expect(prompt).not.toContain("Set passed=true");
    // No combined diff is injected — the auditor reads it from the workspace.
    expect(prompt).not.toContain("Combined writer diff:");
  });

  it("separates each block with a blank line (exact adjacency pins the separators)", () => {
    const prompt = buildAuditorPrompt(ctx);
    // Blank-line separators between the no-write line/spec, criteria/executed,
    // subtasks/rules, and rules/diff. Exact "\n\n" adjacency catches a separator
    // turned into spurious text.
    expect(prompt).toContain("- AC1: all helpers exist\n\nExecuted subtasks:");
    // S3: the rules block is the findings-emission instruction.
    expect(prompt).toContain("behaviors: (none))\n\nEmit your audit as a `findings` list");
    // The prompt ends on the findings-emission instruction — no trailing diff payload.
    expect(prompt.trimEnd().endsWith("finding's severity means for the merge.")).toBe(true);
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
      return completeCheck;
    },
  };
  return adapter;
}

describe("invoke* forwards prompt, workspace, and the canonical schema", () => {
  it("invokeChecker forwards the built prompt + workspace and reports the check schema id", async () => {
    const adapter = recordingChecker();
    const result = await invokeChecker(adapter, {
      context: {
        specTitle: "S",
        specDescription: "D",
        acceptanceCriteria: ["AC1"],
        subtask: subtask(),
        baselineSha: "0".repeat(40),
      },
      workspace: "/ws/repo",
    });
    expect(adapter.last?.workspace).toBe("/ws/repo");
    expect(adapter.last?.prompt).toContain("You are the Tanren Checker Answerer");
    expect(adapter.last?.outputSchema.name).toBe(result.schemaId);
    expect(result.schemaId).toContain("check");
  });

  it("invokePlanner forwards prompt + workspace and returns the plan + schema id", async () => {
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
      rejectionHistory: [],
      workspace: "/ws/plan",
    });
    expect(seen?.workspace).toBe("/ws/plan");
    expect(seen?.prompt).toContain("You are the Tanren Planner Answerer");
    // apex-v76: the SUBTASK SIZING RULE + one-concern-per-subtask examples flow
    // through the adapter — the planner adapter (Codex CLI in production) receives
    // the sizing constraint on every invocation, not just the direct-render path.
    expect(seen?.prompt).toContain("SUBTASK SIZING RULE:");
    expect(seen?.prompt).toContain("Examples of ONE concern (good subtasks):");
    expect(seen?.prompt).toContain("Examples of a TOO-BIG subtask (BAD — do NOT emit):");
    expect(result.plan).toBe(plan);
    expect(result.schemaId).toContain("plan");
  });

  it("invokeAuditor forwards prompt + workspace and reports the audit schema id", async () => {
    let seen: AnswererRunOptions<typeof cleanAudit> | undefined;
    const adapter: AnswererAdapter<typeof cleanAudit> = {
      kind: "answerer",
      cli: "fake",
      authRef: "credential/self-hosted/tanren-fake",
      async runAnswerer(opts) {
        seen = opts;
        return cleanAudit;
      },
    };
    const result = await invokeAuditor(adapter, {
      context: {
        specTitle: "S",
        specDescription: "D",
        acceptanceCriteria: ["AC1"],
        subtasks: [subtask()],
        baselineSha: "0".repeat(40),
      },
      workspace: "/ws/audit",
    });
    expect(seen?.workspace).toBe("/ws/audit");
    expect(seen?.prompt).toContain("You are the Tanren Auditor Answerer");
    expect(result.schemaId).toContain("audit");
  });
});
