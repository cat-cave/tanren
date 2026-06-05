// TEST FIXTURE ONLY (P1c). Deterministic grounded Forge conversation answerer —
// a stand-in for the real provider answerer (`wrapProviderAnswerer`). It MUST NOT
// be constructed by any production/runtime path: the ask route resolves a real
// provider answerer from the project's `forge` routing. It lives under tests/ so
// the §8a arch-lint keeps it out of src/.
//
// It runs inside the same conversation engine, reads a relevant tool to ground
// itself, and finalizes a ForgeAnswer with follow-up chips + an auto-navigate
// card, so a test can exercise the loop without hitting a provider.

import type {
  ForgeAnswererStep,
  ForgeConversationAnswerer,
  ForgeConversationContext,
  ForgeReadToolCall,
} from "../../../src/engine/forge/index.js";
import type { ForgeAnswer, ForgeAttentionItem } from "../../../src/engine/answerers/schemas/forge.js";

type Topic = "costs" | "run" | "insights" | "milestones" | "generic";

function classify(question: string): Topic {
  const q = question.toLowerCase();
  if (/(cost|spend|budget|\$)/u.test(q)) return "costs";
  if (/(run|pr|review|fail|task)/u.test(q)) return "run";
  if (/(insight|stuck|retry|callout|suboptimal)/u.test(q)) return "insights";
  if (/(milestone|roadmap|eta|ship|when)/u.test(q)) return "milestones";
  return "generic";
}

// The read tool this topic wants, given the thread's project scope. Returns
// undefined when no grounding read applies (generic / no project).
function toolForTopic(topic: Topic, projectId: string | null, runId: string | null): ForgeReadToolCall | undefined {
  if ((topic === "run" || topic === "costs") && runId !== null) {
    // The read_costs ForgeToolCall is keyed by runId; project-wide costs are
    // grounded via the costs view navigation card instead of a read here.
    return topic === "costs"
      ? { tool: "tanren.read_costs", args: { runId } }
      : { tool: "tanren.read_run", args: { runId } };
  }
  if (projectId === null) return undefined;
  if (topic === "insights") return { tool: "tanren.read_insights", args: { projectId } };
  if (topic === "milestones") return { tool: "tanren.read_milestones", args: { projectId } };
  return undefined;
}

export function createDeterministicForgeAnswerer(): ForgeConversationAnswerer {
  return {
    async respond(context: ForgeConversationContext): Promise<ForgeAnswererStep> {
      const topic = classify(context.question);
      const tool = toolForTopic(topic, context.projectId, context.runId);

      // First pass with no results yet: request the grounding read tool.
      if (tool !== undefined && context.toolResults.length === 0) {
        return { kind: "tools", toolCalls: [tool] };
      }
      return { kind: "final", answer: finalize(topic, context) };
    },
  };
}

function finalize(topic: Topic, context: ForgeConversationContext): ForgeAnswer {
  const grounded = context.toolResults.length > 0;
  const body = bodyFor(topic, grounded, context);
  const attentionItems = attentionFor(topic, context);
  return {
    body,
    attentionItems,
    insights: [],
    prompts: promptsFor(topic),
  };
}

function bodyFor(topic: Topic, grounded: boolean, context: ForgeConversationContext): string {
  const scope = context.projectId === null ? "your portfolio" : `project <code>${context.projectId}</code>`;
  const groundedNote = grounded ? " I pulled the latest data to ground this." : "";
  switch (topic) {
    case "costs":
      return `Reviewing spend across ${scope}.${groundedNote} Open the costs view for the week-over-week breakdown.`;
    case "run":
      return `Looking at the run you asked about.${groundedNote} The run detail has the full task + review trail.`;
    case "insights":
      return `Scanning workflow insights for ${scope}.${groundedNote} Anything actionable shows in the attention queue.`;
    case "milestones":
      return `Checking milestone progress for ${scope}.${groundedNote} The roadmap shows the critical path.`;
    default:
      return `I read ${scope} — the DAG, recent runs, and your cost windows. Ask me to navigate somewhere or explain what I see.`;
  }
}

// Read-tool actions render as auto-navigate cards in the dashboard; write-tool
// actions are deferred and would render inert. This answerer only emits read
// actions (navigation), keeping inside the read/navigation scope.
function attentionFor(topic: Topic, context: ForgeConversationContext): ForgeAttentionItem[] {
  if (context.runId !== null && topic === "run") {
    return [
      {
        priority: "review",
        title: "Open the run detail",
        sub: `Run ${context.runId}`,
        action: {
          label: "Open run",
          toolCall: { tool: "tanren.read_run", args: { runId: context.runId } },
        },
      },
    ];
  }
  if (context.runId !== null && topic === "costs") {
    return [
      {
        priority: "budget",
        title: "View this run's costs",
        sub: "Per-task spend breakdown",
        action: {
          label: "View costs",
          toolCall: { tool: "tanren.read_costs", args: { runId: context.runId } },
        },
      },
    ];
  }
  return [];
}

function promptsFor(topic: Topic): string[] {
  switch (topic) {
    case "costs":
      return ["where's the waste?", "forecast end of month", "what's the next spec I should run?"];
    case "run":
      return [
        "walk me through the writer's reasoning",
        "show me the auditor's verdict",
        "what's the next step for this PR?",
      ];
    case "insights":
      return ["what needs me right now?", "where's the loop slowest?"];
    case "milestones":
      return ["show the critical path", "what de-risks the next milestone?"];
    default:
      return ["what needs me right now?", "how are costs trending?", "where's the loop slowest?"];
  }
}
