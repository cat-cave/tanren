// P2A-0019: templated v0 narration generator.
//
// Phase 3 swaps this module for an LLM caller without touching the
// `forge_turns` schema. The generator produces a `ForgeAnswer` (the
// P2A-0008 schema) by composing structured project context — recent
// runs, pending reviews, week-to-date cost, velocity, workflow insights
// — into the four shape blocks the hi-fi defines:
//
//   - body: a single-sentence project pulse
//   - attentionItems: ranked queue (pending reviews, budget warnings,
//     blockers)
//   - insights: passed through from P2A-0020 (v0 doesn't generate them)
//   - prompts: hardcoded follow-up prompt list keyed by the project's
//     current state
//
// The generator is pure — it takes a fully-loaded `NarrationInput` and
// returns a `ForgeAnswer`. Loading the context happens upstream so the
// generator stays easily testable from synthetic fixtures.

import type { ActorContext } from "../../../auth/schemas.js";
import type {
  ForgeAnswer,
  ForgeAttentionItem,
  ForgeInsight,
  ForgeSuggestedAction,
} from "../../answerers/schemas/forge.js";

export interface NarrationProject {
  projectId: string;
  name: string;
}

export interface NarrationRun {
  runId: string;
  specId: string;
  status: string;
  outcome: string | null;
  prUrl: string | null;
  startedAt: Date;
  endedAt: Date | null;
  title?: string;
}

export interface NarrationVelocity {
  specsLast14Days: number;
  aheadDays: number;
}

export interface NarrationInsight {
  // Mirrors the ForgeInsight shape from P2A-0008 but with an id so the
  // acknowledge_insight tool has something to bind to.
  id: string;
  kind: ForgeInsight["kind"];
  title: string;
  body: string;
  actions: ForgeSuggestedAction[];
}

export interface NarrationInput {
  project: NarrationProject;
  recentRuns: ReadonlyArray<NarrationRun>;
  pendingReviews: ReadonlyArray<NarrationRun>;
  weekToDateCostUsd: number;
  budgetUsdPerWeek?: number;
  velocity?: NarrationVelocity;
  insights: ReadonlyArray<NarrationInsight>;
  actor: ActorContext;
  // Optional clock injection for deterministic tests.
  now?: Date;
}

function formatCost(usd: number): string {
  if (Number.isNaN(usd)) return "$0";
  if (usd >= 100) return `$${usd.toFixed(0)}`;
  if (usd >= 10) return `$${usd.toFixed(1)}`;
  return `$${usd.toFixed(2)}`;
}

function describeRunHandle(run: NarrationRun): string {
  if (run.prUrl !== null && run.prUrl !== "") {
    const match = run.prUrl.match(/\/pull\/(\d+)/);
    if (match !== null) {
      return `PR #${match[1]}`;
    }
  }
  if (run.title !== undefined && run.title !== "") {
    return run.title;
  }
  return run.runId;
}

// Build the one-sentence body: leads with the pulse the operator most
// wants to see ("3 active, 1 PR ready for review, $42 spent this week").
function buildPulse(input: NarrationInput): string {
  const active = input.recentRuns.filter((run) => run.status === "running" || run.status === "queued").length;
  const reviewReady = input.pendingReviews.length;
  const segments: string[] = [];
  if (active === 0 && reviewReady === 0) {
    segments.push(`${input.project.name} is idle`);
  } else {
    const parts: string[] = [];
    if (active > 0) {
      parts.push(active === 1 ? "1 run in flight" : `${active} runs in flight`);
    }
    if (reviewReady > 0) {
      parts.push(reviewReady === 1 ? "1 PR review-ready" : `${reviewReady} PRs review-ready`);
    }
    segments.push(`${input.project.name}: ${parts.join(", ")}`);
  }
  segments.push(`${formatCost(input.weekToDateCostUsd)} spent this week`);
  if (input.velocity !== undefined && input.velocity.aheadDays !== 0) {
    const direction = input.velocity.aheadDays > 0 ? "ahead" : "behind";
    segments.push(`${Math.abs(input.velocity.aheadDays)} day(s) ${direction}`);
  }
  return segments.join("; ") + ".";
}

// Pending-review attention items — one per PR that is review-ready.
function buildReviewAttentionItems(input: NarrationInput): ForgeAttentionItem[] {
  return input.pendingReviews.map((run) => {
    const handle = describeRunHandle(run);
    const sub =
      run.title !== undefined && run.title !== ""
        ? `${run.title} (run ${run.runId})`
        : `Run ${run.runId} (spec ${run.specId})`;
    return {
      priority: "review" as const,
      title: `${handle} is review-ready`,
      sub,
      action: {
        label: "Open run",
        toolCall: { tool: "tanren.read_run" as const, args: { runId: run.runId } },
      },
    };
  });
}

// Budget attention item — one if WTD spend exceeded the configured budget.
function buildBudgetAttentionItem(input: NarrationInput): ForgeAttentionItem | undefined {
  if (input.budgetUsdPerWeek === undefined) return undefined;
  if (input.weekToDateCostUsd <= input.budgetUsdPerWeek) return undefined;
  return {
    priority: "budget",
    title: `Weekly budget exceeded by ${formatCost(input.weekToDateCostUsd - input.budgetUsdPerWeek)}`,
    sub: `${formatCost(input.weekToDateCostUsd)} spent of ${formatCost(input.budgetUsdPerWeek)} budgeted`,
    action: {
      label: "View costs",
      toolCall: {
        tool: "tanren.read_costs",
        args: {},
      },
    },
  };
}

// Blocked-run attention item — one per failed run with no successor.
function buildBlockedAttentionItems(input: NarrationInput): ForgeAttentionItem[] {
  return input.recentRuns
    .filter((run) => run.status === "failed" || run.outcome === "failed")
    .slice(0, 3)
    .map((run) => ({
      priority: "blocked" as const,
      title: `${describeRunHandle(run)} failed`,
      sub: `Spec ${run.specId} needs attention`,
      action: {
        label: "Rerun task",
        toolCall: { tool: "tanren.rerun_task" as const, args: { taskId: run.runId } },
      },
    }));
}

// Map a NarrationInsight to a ForgeInsight (drop the id — the dashboard
// retrieves it via the action's tool args).
function mapInsight(insight: NarrationInsight): ForgeInsight {
  return {
    kind: insight.kind,
    title: insight.title,
    body: insight.body,
    actions: insight.actions,
  };
}

// Hardcoded suggested-prompt list. v0 keys these to the current state
// (idle / has-review / has-blocked) so the operator sees prompts that
// make sense for the situation. Phase 3 will derive these dynamically.
function buildPrompts(input: NarrationInput): string[] {
  const prompts: string[] = [];
  if (input.pendingReviews.length > 0) {
    prompts.push("What changed in the latest review-ready PR?");
  }
  if (input.recentRuns.some((run) => run.status === "failed")) {
    prompts.push("Why did the latest run fail?");
  }
  if (input.weekToDateCostUsd > 0) {
    prompts.push("How is this week's spend distributed across specs?");
  }
  prompts.push("What's the next spec I should run?");
  if (input.velocity !== undefined && input.velocity.aheadDays < 0) {
    prompts.push("How can I get back on pace?");
  }
  return prompts;
}

export function generateProjectViewNarration(input: NarrationInput): ForgeAnswer {
  const body = buildPulse(input);
  const attentionItems: ForgeAttentionItem[] = [...buildReviewAttentionItems(input)];
  const budgetItem = buildBudgetAttentionItem(input);
  if (budgetItem !== undefined) {
    attentionItems.push(budgetItem);
  }
  attentionItems.push(...buildBlockedAttentionItems(input));
  const prompts = buildPrompts(input);
  return {
    body,
    attentionItems,
    insights: input.insights.map(mapInsight),
    prompts,
  };
}

// ---------------------------------------------------------------------------
// Run-detail narration: a single-run focused narration.
// ---------------------------------------------------------------------------

export interface RunDetailNarrationInput {
  project: NarrationProject;
  run: NarrationRun;
  taskCount: number;
  failedTaskCount: number;
  costUsd: number;
  insights: ReadonlyArray<NarrationInsight>;
  actor: ActorContext;
}

export function generateRunDetailNarration(input: RunDetailNarrationInput): ForgeAnswer {
  const handle = describeRunHandle(input.run);
  const statusPhrase =
    input.run.outcome === "merged" ? "merged" : input.run.outcome === "failed" ? "failed" : input.run.status;
  const body = `${handle} (${statusPhrase}) — ${input.taskCount} tasks, ${formatCost(input.costUsd)} attributed.`;
  const attentionItems: ForgeAttentionItem[] = [];
  if (input.failedTaskCount > 0) {
    attentionItems.push({
      priority: "blocked",
      title: `${input.failedTaskCount} task(s) failed`,
      sub: `Run ${input.run.runId} on spec ${input.run.specId}`,
      action: {
        label: "Read run",
        toolCall: { tool: "tanren.read_run" as const, args: { runId: input.run.runId } },
      },
    });
  }
  if (input.run.prUrl !== null && input.run.prUrl !== "" && input.run.outcome !== "merged") {
    attentionItems.push({
      priority: "review",
      title: `${handle} is review-ready`,
      sub: input.run.prUrl,
      action: {
        label: "Open PR",
        toolCall: { tool: "tanren.read_run" as const, args: { runId: input.run.runId } },
      },
    });
  }
  return {
    body,
    attentionItems,
    insights: input.insights.map(mapInsight),
    prompts: [
      "Walk me through the writer's reasoning.",
      "Show me the auditor's verdict.",
      "What's the next step for this PR?",
    ],
  };
}
