// The conflict-resolution Answerer invoker (autonomy-engine.md §2b step 3;
// PROJECT_BRIEF §2.2). Wraps the routing-resolved conflict Answerer adapter +
// builds the prompt that hands the model BOTH conflicting specs' intent +
// acceptance criteria, the conflict hunks, and the DAG edge — then returns the
// schema-validated ConflictAnswer.
//
// Writer/Answerer boundary (PROJECT_BRIEF §3): this is an ANSWERER. It is
// read-only — it never edits files, runs commands, or merges. It only judges the
// conflict and returns the structured resolution plan; the
// WorkspaceConflictApplier (the writer-adjacent step) owns applying the tree over
// the runner, and the re-gate owns verifying it. The Answerer contract's schema
// validation rejects a non-conforming model output (the same gate the
// planner/checker/auditor/reviewer Answerers use).

import { answererOutputSchemaFor, ConflictAnswer } from "../../../answerers/schemas/index.js";
import type { AnswererAdapter } from "../../../providers/types.js";
import {
  isProductVisionEmpty,
  type ConflictAnswererInvoker,
  type ConflictedFile,
  type ProductVision,
  type SpecIntent,
  type UpstreamChangeContext,
} from "../../../contracts/conflictResolution.js";

export interface AnswererBackedConflictInvokerDeps {
  adapter: AnswererAdapter<ConflictAnswer>;
  timeoutMs: number;
  workspace?: string;
}

export class AnswererBackedConflictInvoker implements ConflictAnswererInvoker {
  constructor(private readonly deps: AnswererBackedConflictInvokerDeps) {}

  async resolve(input: {
    mergingSpecIntent: SpecIntent;
    conflictingSpecIntent?: SpecIntent;
    dagEdge: boolean;
    conflictedFiles: ReadonlyArray<ConflictedFile>;
    upstreamChange?: UpstreamChangeContext;
    productVision?: ProductVision;
  }): Promise<ConflictAnswer> {
    const outputSchema = answererOutputSchemaFor("conflict", ConflictAnswer);
    const prompt = buildConflictResolverPrompt(input);
    const answerOpts: Parameters<typeof this.deps.adapter.runAnswerer>[0] = {
      prompt,
      timeoutMs: this.deps.timeoutMs,
      outputSchema,
      ...(this.deps.workspace !== undefined && { workspace: this.deps.workspace }),
    };
    return this.deps.adapter.runAnswerer(answerOpts);
  }
}

export function buildConflictResolverPrompt(input: {
  mergingSpecIntent: SpecIntent;
  conflictingSpecIntent?: SpecIntent;
  dagEdge: boolean;
  conflictedFiles: ReadonlyArray<ConflictedFile>;
  upstreamChange?: UpstreamChangeContext;
  productVision?: ProductVision;
}): string {
  const lines: string[] = [
    ...(input.upstreamChange === undefined ? conflictFraming() : upstreamChangeFraming(input.upstreamChange)),
    ...productVisionFraming(input.productVision),
    "",
    "Hard boundaries (you are an Answerer — read-only):",
    "- Do NOT run, simulate, or shell out to tests/builds/linters. A separate",
    "  deterministic gate (run AFTER you) verifies the resolved tree.",
    "- Do NOT edit files or create commits. You return a structured PLAN only; the",
    "  orchestrator applies it and re-gates.",
    "",
    "Decide ONE of:",
    "- decision='resolve': return `resolvedFiles` with the FULL resolved content",
    "  (conflict markers removed) for EVERY conflicted file, preserving BOTH",
    "  intents. Leave `replanSpec` null.",
    "- decision='irreconcilable': the two intents CANNOT both be satisfied by one",
    "  edit. Return `replanSpec` naming which spec to re-plan ('merging' = the spec",
    "  whose PR is merging; 'base' = the spec already merged on the base branch)",
    "  and `newContext` = the OTHER spec's change as planning context, so the",
    "  re-planned spec satisfies its intent ON TOP of the other's. Leave",
    "  `resolvedFiles` empty. (Intent stays alive; nothing is dropped or merged.)",
    "",
    `DAG edge between the two specs: ${input.dagEdge ? "YES (a known dependency relationship)" : "NO (no persisted dependency edge)"}`,
    "",
    input.upstreamChange === undefined
      ? "=== MERGING spec (the PR being merged) ==="
      : "=== DEPENDENT spec (whose work must be KEPT INTACT while absorbing the upstream change) ===",
    ...specIntentLines(input.mergingSpecIntent),
    "",
    input.upstreamChange === undefined
      ? "=== BASE spec (the change already on the base branch) ==="
      : `=== ANCESTOR spec ${input.upstreamChange.ancestorSpecId} (whose intentional upstream change must flow IN) ===`,
    ...baseSpecLines(input.conflictingSpecIntent),
    "",
    "=== Conflicted files (markers intact) ===",
    ...input.conflictedFiles.flatMap((file) => [`--- ${file.path} ---`, file.conflictedContent]),
    "",
    "Return only the structured JSON required by the provided schema.",
  ];
  return lines.join("\n");
}

/** The default (symmetric merge-conflict) framing header. */
function conflictFraming(): string[] {
  return [
    "You are the Tanren Conflict-Resolution-Planner Answerer. A merge conflict",
    "arose between TWO specs' changes. A conflict is a RE-PLANNING problem, not a",
    "text-picking problem: you have BOTH specs' intent + acceptance criteria, so",
    "resolve to satisfy BOTH intents — never pick one side's text and drop the",
    "other's intent.",
  ];
}

/**
 * The upstream-change framing header: this is NOT a symmetric collision —
 * an ANCESTOR changed AFTER the DEPENDENT started speculatively, and the
 * ancestor's intentional change must flow INTO the dependent while the dependent's
 * own work stays intact. `decision='resolve'` = the absorbed tree (keep BOTH); an
 * `irreconcilable` answer must route the 'merging' side (= the dependent) back to
 * the planner with the ancestor's change as context. Same schema, same invariants.
 */
function upstreamChangeFraming(upstream: UpstreamChangeContext): string[] {
  return [
    "You are the Tanren Conflict-Resolution-Planner Answerer, in UPSTREAM-CHANGE",
    "mode. A dependent spec started building speculatively on an ancestor; the",
    `ANCESTOR (${upstream.ancestorSpecId}) has since changed and that change must`,
    "PERCOLATE DOWN into the dependent. This is NOT a symmetric conflict: the",
    "ancestor's change is intentional and authoritative — apply it INTO the",
    "dependent WHILE KEEPING THE DEPENDENT'S OWN WORK INTACT. Never discard the",
    "dependent's work, and never drop the ancestor's change.",
    "",
    `Upstream change to absorb: ${upstream.changeSummary}`,
  ];
}

/**
 * The PRODUCT-VISION framing section: the personas, the persona-behaviors tied to
 * the two conflicting specs, and the captured design-DNA the resolution must
 * honor AND use to judge whether the two intents GENUINELY clash. This is the
 * signal that sharpens the classification (escalation discipline): a resolution
 * that would VIOLATE a persona's behavior — or that cannot satisfy two specs'
 * persona-behaviors that genuinely contradict — is a real PRODUCT-INTENT clash
 * (the legitimate `irreconcilable` product decision a human owns); a merely
 * MECHANICAL clash between compatible intents stays autonomously resolvable.
 *
 * Omitted entirely for a genuinely empty product (no personas / behaviors /
 * design-DNA) — a real empty state, NOT a stub: the resolver simply judges on the
 * spec intents + hunks as before.
 */
function productVisionFraming(vision: ProductVision | undefined): string[] {
  if (vision === undefined || isProductVisionEmpty(vision)) return [];
  const lines: string[] = [
    "",
    "=== Product vision the resolution must HONOR + use to judge whether these two intents genuinely clash ===",
    "Frame the resolution so it keeps the product true to its personas + their",
    "behaviors. CRUCIALLY: judge the conflict against this vision. If satisfying",
    "BOTH specs would require CONTRADICTING a persona's behavior (two personas'",
    "behaviors genuinely cannot both be true), that is a real PRODUCT-INTENT clash —",
    "answer 'irreconcilable' and name the spec to re-plan. If the intents are",
    "COMPATIBLE with the vision and only the TEXT collides, resolve to satisfy both.",
  ];
  if (vision.designDna !== undefined && vision.designDna.trim() !== "") {
    lines.push("", `Design-DNA / identity: ${vision.designDna.trim()}`);
  }
  if (vision.personas.length > 0) {
    lines.push("", "Personas:");
    for (const p of vision.personas) {
      const surface = p.surface !== undefined && p.surface.trim() !== "" ? ` [surface: ${p.surface.trim()}]` : "";
      lines.push(`- ${p.name}${surface}: ${p.description}`);
    }
  }
  if (vision.behaviors.length > 0) {
    lines.push("", "Behaviors tied to the two conflicting specs (must stay true):");
    for (const b of vision.behaviors) {
      lines.push(`- (${b.persona}) ${b.title}: given ${b.given}, when ${b.when}, then ${b.thenOutcome}`);
    }
  }
  return lines;
}

function baseSpecLines(conflictingSpecIntent: SpecIntent | undefined): string[] {
  if (conflictingSpecIntent === undefined) {
    return [
      "(No other spec could be attributed to the conflicting change. Resolve to",
      "preserve the MERGING spec's intent on top of the base-branch change, or",
      "route the merging spec back to the planner if that is impossible.)",
    ];
  }
  return specIntentLines(conflictingSpecIntent);
}

function specIntentLines(intent: SpecIntent): string[] {
  return [
    `Spec id: ${intent.specId}`,
    `Title: ${intent.title}`,
    `Description: ${intent.description}`,
    "Acceptance criteria:",
    ...intent.acceptanceCriteria.map((c) => `- ${c}`),
  ];
}
