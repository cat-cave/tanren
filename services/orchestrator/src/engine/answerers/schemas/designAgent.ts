// Design-Agent ANSWER schema (WS-D3 of docs/roadmap/native-design-subsystem.md).
// The DESIGN AGENT is the native authoring counterpart of the design ORACLE
// (WS-D4): where the oracle VERIFIES the built output against the contract, the
// agent AUTHORS the contract itself. It runs as a design PHASE BEFORE the build
// nodes (designPhase.ts) and ELABORATES the thin design intent captured straight
// from the Forge interview (WS-D1) into a full, persona-scoped, behavior-covering,
// domain-appropriate `DesignContractV1` — the durable design artifact the writer
// (WS-D2) then builds from and the oracle (WS-D4) verifies against. This closes
// Tanren's no-handoff loop: interview intent → design agent authors the contract →
// writer implements → oracle verifies → re-drive.
//
// SCOPE BOUNDARY — the agent authors the CONTRACT, not the product UI. In Tanren's
// no-handoff model the WRITER realizes the hi-fi from the contract (WS-D2); the
// agent never emits product code. Its output is exactly an elaborated contract.
//
// THE MOAT — the agent exploits Tanren's native graph in a way no standalone design
// tool can (a handoff tool has neither a behavior model nor a persona graph):
//   1. BEHAVIOR CHECKLIST — the agent is handed the project's first-class
//      `behaviors` (resolved given/when/then) and MUST map EVERY behavior to a
//      designed surface/flow in the elaborated contract. The phase REJECTS an
//      output that drops a behavior (loud non-coverage), so the contract is an
//      exhaustive, checkable design plan — the SAME behaviors the writer builds and
//      the oracle checks (the designer↔implementor gap closed).
//   2. STRICT PERSONA RESOLUTION — the agent designs against the project's ACTUAL
//      `personas` (resolved ids), never "assume a default user". Each behavior's
//      coverage is attributed to a persona; dimensions may be persona-scoped.
//   3. DOMAIN-APPROPRIATE — the agent CHOOSES the design `dimensions` from the
//      project's domain/intent (web → tokens/components/layout; game →
//      art-direction/ui/feel; novel → typography/voice/cover). Tanren NEVER branches
//      on the domain in code — the agent derives the dimension set, mirroring how
//      the oracle (WS-D4) derives its verification mode.
//
// NO SILENT DEFAULTS / FAIL-CLOSED. The output is parsed by the strict
// `DesignAgentAnswer` Zod schema — a malformed/partial answer THROWS (loud, never a
// defaulted stub). The phase additionally asserts EXHAUSTIVE behavior coverage and
// that every persona/behavior the agent references resolves to a real entity id —
// a dangling ref or a missing behavior is a LOUD failure, never a quiet drop. Like
// the spec-quality validator + the inbox-triage answerer, this schema is
// intentionally NOT in `answererSchemaCatalog`; the phase renders its JSON Schema
// inline via `renderAnswererJsonSchema`, so the LLM and the runtime parser see the
// same OpenAI-strict shape without a codegen round.

import { z } from "zod";

export const DESIGN_AGENT_ANSWER_SCHEMA_ID = "tanren.design_agent_answer.v1" as const;

// One designed surface/flow that COVERS a specific behavior. This is the moat's
// behavior-checklist made concrete: the agent must produce one of these for EVERY
// behavior it is handed (the phase asserts the set is exhaustive). It names the
// behavior id it covers (so coverage is checkable), the persona the surface is for
// (strict resolution — never "default user"), and the dimension key the surface
// lives under (so the design is tied to the contract's domain-derived facets).
export const DesignedSurface = z
  .object({
    // The id of the behavior this surface/flow covers. MUST be one of the behavior
    // ids the agent was handed — the phase rejects an unknown id (loud).
    behaviorId: z
      .string()
      .min(1)
      .describe("The id of the behavior this designed surface/flow covers (must be one of the behaviors provided)."),
    // The id of the persona this surface is designed for (strict resolution). MUST be
    // one of the persona ids handed to the agent.
    personaId: z
      .string()
      .min(1)
      .describe("The id of the persona this surface is designed for (must be one of the personas provided)."),
    // The dimension key (from the agent's own `dimensions` set) this surface lives
    // under — tying the behavior's coverage to a domain-derived design facet.
    dimensionKey: z
      .string()
      .min(1)
      .max(80)
      .describe("The dimension key (one of your declared dimensions) this surface lives under."),
    // The designed surface/flow itself: WHAT the user sees/does to fulfil the
    // behavior, design-wise (a screen, a flow, a chapter layout, a HUD element).
    surface: z
      .string()
      .min(1)
      .max(2000)
      .describe("The designed surface or flow that covers this behavior for this persona (what the user sees/does)."),
  })
  .strict();
export type DesignedSurface = z.infer<typeof DesignedSurface>;

// One elaborated, domain-adaptive design DIMENSION the agent authored. Mirrors the
// `DesignDimension` shape of the persisted contract (designContract.ts) — the phase
// maps these 1:1 into the persisted `DesignContractV1`. The agent CHOOSES the set
// from the domain (Tanren names none); `personaIds` express a persona-scoped view.
export const DesignAgentDimension = z
  .object({
    key: z.string().min(1).max(80).describe("Stable opaque dimension slug you choose from the domain (e.g. tokens)."),
    label: z.string().min(1).max(160).describe("Human-readable dimension name (e.g. 'Design tokens')."),
    intent: z
      .string()
      .min(1)
      .max(2000)
      .describe("What GOOD design looks like on this dimension — the bar to build to."),
    guidance: z.string().max(2000).describe("Optional do/don't, references, anti-ai-slop craft notes. Empty if none."),
    // Persona-scoped design: the persona ids whose view this dimension describes.
    // EMPTY ⇒ applies to every persona on the contract. Each id MUST resolve.
    personaIds: z
      .array(z.string().min(1))
      .describe("Persona ids whose view this dimension scopes (must be provided personas); empty = all personas."),
  })
  .strict();
export type DesignAgentDimension = z.infer<typeof DesignAgentDimension>;

export const DesignAgentAnswer = z
  .object({
    // The descriptive design DOMAIN label the agent DERIVED from the intent (e.g.
    // "saas-web", "mobile-game", "novel-translation"). Tanren never branches on it;
    // it is the signal the oracle (WS-D4) reads to choose its verification mode.
    domain: z
      .string()
      .min(1)
      .max(120)
      .describe("The descriptive design domain label you derived (e.g. saas-web, mobile-game, novel-translation)."),
    // The universal contract core (domain-independent) — elaborated from the thin
    // captured intent. These map 1:1 onto the persisted contract's core.
    identity: z.string().min(1).max(400).describe("The one-line design identity (what the product IS, design-wise)."),
    intent: z.string().min(1).max(4000).describe("The overarching design intent / north star prose."),
    principles: z
      .array(z.string().min(1).max(400))
      .describe("Durable design principles / rules (may be empty if expressed via dimensions)."),
    constraints: z
      .array(z.string().min(1).max(400))
      .describe("Hard design constraints / non-negotiables (accessibility, platform HIG, register). May be empty."),
    // The domain-derived dimension set the agent CHOSE (web → tokens/components; game
    // → art-direction/feel; novel → typography/voice). Tanren names none.
    dimensions: z
      .array(DesignAgentDimension)
      .min(1)
      .describe("The domain-appropriate design dimensions you chose (at least one)."),
    // THE MOAT — the exhaustive behavior-coverage plan: one designed surface per
    // behavior the agent was handed. The phase asserts every behavior id appears.
    coverage: z
      .array(DesignedSurface)
      .describe(
        "One designed surface/flow per behavior you were handed — EVERY behavior must be covered (exhaustive checklist).",
      ),
  })
  .strict();

export type DesignAgentAnswer = z.infer<typeof DesignAgentAnswer>;
