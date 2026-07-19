// Native design subsystem (WS-D3) — the DESIGN AGENT seam: the prompt + the
// provider-adapter wrapper for the native design-authoring agent. The agent runs
// as a design PHASE before the build nodes (designPhase.ts) and ELABORATES the thin
// design intent captured from the Forge interview (WS-D1) into a full,
// persona-scoped, behavior-covering, domain-appropriate `DesignContract` — the
// durable artifact the writer (WS-D2) builds from and the oracle (WS-D4) verifies.
//
// SCOPE BOUNDARY: the agent authors the CONTRACT, never the product UI (the WRITER
// realizes the hi-fi from the contract — Tanren's no-handoff model). Its output is
// exactly an elaborated `DesignAgentAnswer`.
//
// THE MOAT (see designAgent.ts schema header): the prompt hands the agent the
// project's first-class personas (resolved — strict, no "default user") + behaviors
// (resolved given/when/then — the exhaustive coverage checklist) + the thin captured
// intent, and tells it to DERIVE the domain-appropriate dimension set itself (Tanren
// never branches on domain). The phase then asserts EXHAUSTIVE behavior coverage.
//
// Like the spec-quality validator, this is a read-only authoring answerer that
// renders its JSON Schema inline via `renderAnswererJsonSchema` (NOT in the
// answerer-schema catalog), and a strict parse on the output makes a malformed
// answer THROW (loud, never a defaulted stub).

import { DESIGN_AGENT_ANSWER_SCHEMA_ID, DesignAgentAnswer } from "../answerers/schemas/designAgent.js";
import { renderAnswererJsonSchema } from "../answerers/schemas/index.js";
import type { AnswererAdapter } from "../providers/types.js";

// Re-exported so callers wiring the design-agent factory (providerFactory.ts) reach
// the answer type through this seam module rather than a second schema import.
export type { DesignAgentAnswer } from "../answerers/schemas/designAgent.js";

// A persona resolved to its human-readable identity, for the agent's prompt. The
// agent designs against the NAME + description (the actual role) and references the
// stable `id` in its output (strict resolution — the phase re-checks every id).
export interface DesignAgentPersona {
  id: string;
  name: string;
  description: string;
}

// A behavior resolved to its given/when/then + the persona it belongs to. These are
// the design ACCEPTANCE CRITERIA the agent must cover exhaustively (the moat).
export interface DesignAgentBehavior {
  id: string;
  // The persona id this behavior belongs to (so coverage is attributed per persona).
  personaId: string;
  title: string;
  given: string;
  when: string;
  // The BDD then-OUTCOME (named `thenOutcome` to avoid a `then` key reading as a
  // thenable — the same naming the writer context + conflict resolver use).
  thenOutcome: string;
}

// The thin design intent captured straight from the interview (WS-D1) — the seed
// the agent elaborates. All fields may be terse; the agent's job is to expand them
// into a full contract while honoring whatever the operator already expressed.
export interface CapturedDesignSeed {
  // The descriptive domain label the operator/interview implied (may be terse). The
  // agent may refine it; Tanren never branches on it.
  domain: string;
  identity: string;
  intent: string;
  principles: ReadonlyArray<string>;
  constraints: ReadonlyArray<string>;
}

export interface DesignAgentInput {
  seed: CapturedDesignSeed;
  // The project's ACTUAL personas (strict resolution — the agent designs against
  // these, never a guessed default user).
  personas: ReadonlyArray<DesignAgentPersona>;
  // The behaviors the design is responsible for COVERING (the exhaustive checklist).
  behaviors: ReadonlyArray<DesignAgentBehavior>;
}

// The design-agent seam — mirrors the spec-quality / discovery answerer shape so the
// derive path wires a real provider answerer and tests inject a fake.
export interface DesignAgent {
  elaborate(input: DesignAgentInput): Promise<DesignAgentAnswer>;
}

function renderPersona(persona: DesignAgentPersona): string {
  const desc = persona.description.trim() === "" ? "(no description)" : persona.description;
  return `- [${persona.id}] ${persona.name}: ${desc}`;
}

function renderBehavior(behavior: DesignAgentBehavior): string {
  return [
    `- [${behavior.id}] (persona ${behavior.personaId}) ${behavior.title}`,
    `    Given ${behavior.given}`,
    `    When ${behavior.when}`,
    `    Then ${behavior.thenOutcome}`,
  ].join("\n");
}

function renderList(label: string, items: ReadonlyArray<string>): string[] {
  return items.length === 0 ? [`${label}: (none provided)`] : [`${label}:`, ...items.map((i) => `- ${i}`)];
}

// buildDesignAgentPrompt renders the read-only authoring prompt: the thin captured
// seed, the resolved personas + behaviors (the moat inputs), and the strict output
// instruction. Exported for the prompt-shape test.
export function buildDesignAgentPrompt(input: DesignAgentInput): string {
  const { seed } = input;
  return [
    "You are the Tanren Design Agent. Your ONLY job is to AUTHOR a DESIGN CONTRACT:",
    "elaborate the thin design intent below into a FULL, persona-scoped, behavior-",
    "covering, domain-appropriate design contract. You do NOT write product code — the",
    "Tanren writer realizes the design from your contract (there is NO handoff to a",
    "separate tool). You are READ-ONLY: do not edit files, run commands, or write",
    "anything — only author the contract as the structured JSON the schema requires.",
    "",
    "DOMAIN-APPROPRIATE — you are NOT assuming a web UI. DERIVE the design dimensions",
    "that fit THIS product's domain and intent: a SaaS web app → tokens / components /",
    "layout; a mobile game → art-direction / ui / game-feel; a novel translation →",
    "typography / voice / cover. Choose the dimension SET yourself from the domain; do",
    "not force a web vocabulary onto a non-web product. Set `domain` to the descriptive",
    "label you derive.",
    "",
    "THE BEHAVIOR CHECKLIST (exhaustive — this is non-negotiable): you are handed every",
    "behavior the design is responsible for. EVERY behavior MUST be covered by at least",
    "one designed surface/flow in your `coverage` array, attributed to that behavior's",
    "persona and tied to one of your dimensions (a real flow may span multiple surfaces,",
    "so a behavior MAY have more than one coverage entry). A behavior with NO covering",
    "surface is an incomplete contract and will be REJECTED. Do not invent behaviors;",
    "cover the ones provided.",
    "",
    "STRICT PERSONA RESOLUTION: design against the ACTUAL personas below — never assume",
    "a default user. Reference personas by their provided id in `coverage` and in any",
    "persona-scoped dimension's `personaIds`.",
    "",
    "==== THE THIN CAPTURED DESIGN INTENT (your seed — elaborate, honor what is here) ====",
    `Captured domain hint: ${seed.domain}`,
    `Captured identity: ${seed.identity}`,
    `Captured intent: ${seed.intent}`,
    ...renderList("Captured principles", seed.principles),
    ...renderList("Captured constraints", seed.constraints),
    "",
    "==== PERSONAS (resolved — design for each, no guessing) ====",
    ...(input.personas.length === 0
      ? ["(no personas — design a single coherent contract)"]
      : input.personas.map(renderPersona)),
    "",
    "==== BEHAVIORS TO COVER (exhaustive checklist — every one needs a designed surface) ====",
    ...(input.behaviors.length === 0
      ? ["(no behaviors bound — author the core + dimensions; `coverage` is empty)"]
      : input.behaviors.map(renderBehavior)),
    "",
    "==== HOW TO ANSWER ====",
    "Return exactly one DesignAgentAnswer:",
    "- `domain`: the descriptive design domain label you derived.",
    "- `identity` / `intent`: the elaborated one-line identity + north-star intent.",
    "- `principles` / `constraints`: the durable design rules + non-negotiables (arrays;",
    "  empty arrays allowed when fully expressed via dimensions).",
    "- `accessibilityPosture`: the a11y bar you INFER from the product intent/audience.",
    '  Pick a real WCAG standard (e.g. "wcag-2.2-aa") ONLY when the product genuinely',
    '  calls for one; otherwise use "none" HONESTLY (advisory). Never invent a bar —',
    "  a public consumer/gov surface implies AA; a throwaway internal tool implies none.",
    "- `dimensions`: the domain-appropriate facets you chose (at least one), each with a",
    "  stable `key`, `label`, `intent` (what good looks like), `guidance` (or empty),",
    "  and `personaIds` (empty = all personas, else provided persona ids).",
    "- `coverage`: AT LEAST one entry per behavior above (more when a behavior's flow",
    "  spans surfaces) — `behaviorId` (a provided behavior id), `personaId` (that",
    "  behavior's persona), `dimensionKey` (one of your dimensions), and `surface` (the",
    "  designed surface/flow that covers it). Cover EVERY behavior.",
  ].join("\n");
}

// No bounding option remains: each provider answerer call is governed by the agent
// ActivityWatchdog (output-driven, never a wall-clock kill) the adapter constructs.
export type WrapProviderDesignAgentOptions = Record<never, never>;

// Adapt an `AnswererAdapter` into the `DesignAgent` seam. The strict
// `DesignAgentAnswer` parse on the output makes a malformed answer THROW (loud).
export function wrapProviderDesignAgent(
  adapter: AnswererAdapter<DesignAgentAnswer>,
  _options: WrapProviderDesignAgentOptions = {},
): DesignAgent {
  const jsonSchema = renderAnswererJsonSchema(DesignAgentAnswer);
  return {
    async elaborate(input: DesignAgentInput): Promise<DesignAgentAnswer> {
      return adapter.runAnswerer({
        prompt: buildDesignAgentPrompt(input),
        outputSchema: {
          name: DESIGN_AGENT_ANSWER_SCHEMA_ID,
          jsonSchema,
          parse: (value) => DesignAgentAnswer.parse(value),
        },
      });
    },
  };
}
