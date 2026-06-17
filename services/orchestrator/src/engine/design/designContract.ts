// Tanren-native design subsystem (WS-D1) — the domain-general `DesignContract`
// schema + parser. This is the durable design ARTIFACT: the first-class,
// persisted, versioned design-intent contract that LATER workstreams inject into
// the writer on every generation (WS-D2) and verify with a domain-aware design
// oracle (WS-D4). It SUPERSEDES the decorative 80-char `designDna` interview hint
// (which never reached the writer — it only framed merge conflicts + a slug
// fallback). See docs/roadmap/native-design-subsystem.md.
//
// DOMAIN-GENERAL BY CONSTRUCTION. Tanren builds anything (the general-build-engine
// doctrine — a "repo" could be a fan-translation where a bug is a grammar error),
// so the contract's SHAPE must adapt to the project domain, exactly as the
// project-declared lifecycle (stack-flexible-contract.md) and the template
// manifest's capability set do. The web "design system" (tokens / components /
// layout / elevation / responsive) is ONE INSTANCE of the contract, NOT the
// model. So the contract is:
//
//   - a typed CORE that is universal across ANY design domain: the design
//     `identity`, the design `intent`, the `principles`, and the `constraints`;
//   - a domain-derived `domain` LABEL (descriptive — Tanren NEVER branches on it,
//     exactly like the lifecycle's `stack` label);
//   - a domain-adaptive `dimensions` SET whose membership is DECLARED by the
//     project/domain, not fixed by Tanren. A SaaS app declares dimensions
//     `[tokens, components, layout]`; a mobile game `[art-direction, ui,
//     game-feel]`; a novel translation `[typography, voice, layout, cover]`.
//     Each dimension carries its own `intent` (what good looks like there) and
//     optional `guidance`. The design oracle (WS-D4) reads these dimensions to
//     decide what to verify and HOW (render/screenshot for web, prose/typography
//     for a novel) — the contract NEVER hardcodes a verification mode; AND
//   - THE MOAT — FIRST-CLASS LINKS into Tanren's native entity graph
//     (`personaRefs` + `behaviorRefs`). This is what no external design tool CAN
//     do: Claude Design / open-design must ASK "who is this for? assume admin?"
//     and throw a freeform `DESIGN.md` over a wall. Tanren resolves it STRICTLY
//     because personas + behaviors are TYPED ENTITIES (the `personas` /
//     `behaviors` tables):
//       · `personaRefs` binds the contract to the project's ACTUAL personas, so
//         design is resolved PER-PERSONA — no "assume default admin" ambiguity. A
//         dimension may ALSO carry its own `personaRefs` to express "THIS persona's
//         view of THIS surface" (persona-scoped design; consumed in WS-D3/D4).
//       · `behaviorRefs` binds the BEHAVIORS (given/when/then) the design is
//         responsible for covering — design ACCEPTANCE CRITERIA. This closes the
//         designer↔implementor gap: the design agent (WS-D3) gets an exhaustive
//         checklist, the design oracle (WS-D4) verifies behavior coverage of the
//         hi-fi, AND the implementor builds from the SAME behaviors the design was
//         designed against — one entity graph, no disconnect.
//     These links are DOMAIN-GENERAL (a novel translation has personas =
//     readers/editor + behaviors too), so binding to them strengthens generality
//     rather than web-baking. WS-D1 lands the LINKS (the foundation); their
//     CONSUMPTION (coverage-checking, persona-scoped rendering) is WS-D3/D4.
//
// NO SILENT DEFAULTS. Like the template manifest + the ci.yml parser, a malformed
// contract ALWAYS throws (never degrades to a default): a half-described design
// contract is a LOUD failure, not a quiet stub. The required core fields
// (`domain`, `identity`, `intent`) must be present + non-empty; an absent design
// contract is a separate, explicit state (no contract row), never a defaulted one.
//
// This module is the CONTRACT + PARSER only. It never persists, injects, or
// verifies — the persistence is the `design_contracts` store (the `Repositories`
// seam); injection is WS-D2; the oracle is WS-D4. Those are the clean seams this
// foundation leaves.

import { z } from "zod";

export const DESIGN_CONTRACT_VERSION = 1 as const;

// ---- Dimension -------------------------------------------------------------

// One domain-adaptive design DIMENSION. The SET of dimensions is the project's
// own declaration (domain-derived), so a never-seen design domain is described by
// the dimensions it chooses, never by a hardcoded web schema. `key` is a stable
// opaque slug the oracle keys verification off; `label` is human-readable;
// `intent` says what GOOD looks like on this dimension (the bar the oracle judges
// against); `guidance` is optional elaboration (do/don't, references). Tanren
// names NO specific dimension — `tokens`/`art-direction`/`typography` are all
// equally valid free declarations.
export const DesignDimension = z
  .object({
    // The stable, opaque dimension key (e.g. "tokens", "art-direction",
    // "typography"). Domain-declared — never a Tanren-privileged enum.
    key: z.string().min(1).max(80),
    // The human-readable dimension name (e.g. "Design tokens", "Art direction").
    label: z.string().min(1).max(160),
    // What GOOD design looks like on THIS dimension — the bar the design oracle
    // (WS-D4) judges fidelity against. Required + non-empty: a dimension with no
    // intent carries no design signal, so it fails LOUDLY here.
    intent: z.string().min(1).max(2000),
    // Optional elaboration (do/don't, references, anti-ai-slop craft notes). Free
    // text; absent when the dimension's intent is self-contained.
    guidance: z.string().max(2000).default(""),
    // PERSONA-SCOPED design (the moat): the persona ids whose view this dimension
    // describes ("THIS persona's view of THIS surface"). References the project's
    // actual `personas` rows — so a surface is resolved per-persona, never "assume
    // default admin". EMPTY ⇒ the dimension applies to every persona on the
    // contract (a real all-personas state). Consumed in WS-D3/D4.
    personaRefs: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type DesignDimension = z.infer<typeof DesignDimension>;

// ---- Core ------------------------------------------------------------------

// The universal, domain-INDEPENDENT core every design contract carries, whatever
// the domain. These are the design-intent fields that mean the same thing for a
// SaaS dashboard, a mobile game, and a novel translation.
//
// `identity` — the one-line design identity / brand feel (what the thing IS,
//   design-wise: "calm, dense, trustworthy ops console"; "warm hand-drawn cozy
//   game"; "austere literary classic").
// `intent` — the overarching design intent / north star prose: the design vision
//   the writer builds toward + the oracle verifies against.
// `principles` — the durable design principles / rules (the design "rulesets":
//   "never more than two accent colors"; "no AI-slop gradients"; "keep the
//   translator's voice consistent").
// `constraints` — hard design constraints / non-negotiables (accessibility AA;
//   platform HIG; the source work's register).
const DesignContractCore = {
  // The one-line design identity (what the product IS, design-wise). Required.
  identity: z.string().min(1).max(400),
  // The overarching design intent / north star (the vision the writer builds
  // toward + the oracle verifies against). Required + non-empty (a contract with
  // no intent has nothing to inject or verify — a LOUD failure, not a stub).
  intent: z.string().min(1).max(4000),
  // Durable design principles / rules (the design "rulesets"). May be empty (a
  // real empty state — some contracts express everything via dimensions).
  principles: z.array(z.string().min(1).max(400)).default([]),
  // Hard design constraints / non-negotiables. May be empty.
  constraints: z.array(z.string().min(1).max(400)).default([]),
} as const;

// ---- Contract --------------------------------------------------------------

// The full, domain-general design contract. `version` pins the shape; `domain` is
// the descriptive domain LABEL (Tanren never branches on it); the core fields are
// universal; `dimensions` is the domain-adaptive section set. `strict()` rejects
// unknown keys — a contract is exactly this shape or it fails LOUDLY.
export const DesignContractV1 = z
  .object({
    version: z.literal(DESIGN_CONTRACT_VERSION),
    // The descriptive design DOMAIN label ("saas-web", "mobile-game",
    // "novel-translation"). Human-readable + domain-derived — Tanren NEVER
    // switches on it (the same posture as the lifecycle's `stack` label). It is
    // the signal the design AGENT (WS-D3) + ORACLE (WS-D4) use to choose how to
    // author + how to verify, NOT a Tanren-side branch.
    domain: z.string().min(1).max(120),
    ...DesignContractCore,
    // THE MOAT — FIRST-CLASS PERSONA LINKS. The ids of the project's `personas`
    // this design serves: design is resolved PER-PERSONA against typed entities,
    // not guessed (no "assume default admin"). EMPTY at first capture is a real
    // empty state (no personas bound yet); the design phase (WS-D3) binds them.
    personaRefs: z.array(z.string().min(1)).default([]),
    // THE MOAT — FIRST-CLASS BEHAVIOR LINKS. The ids of the `behaviors`
    // (given/when/then) this design is responsible for COVERING — design
    // ACCEPTANCE CRITERIA. The design agent (WS-D3) gets these as an exhaustive
    // checklist; the design oracle (WS-D4) verifies the hi-fi covers them; the
    // implementor builds from the SAME behaviors. EMPTY ⇒ no behaviors bound yet.
    behaviorRefs: z.array(z.string().min(1)).default([]),
    // The domain-adaptive dimension set — DECLARED by the project/domain, never a
    // fixed web schema. May be empty at first capture (the core alone is a valid
    // contract); the design phase (WS-D3) enriches the dimensions. De-duped by
    // `key` when merged (see the interview capture).
    dimensions: z.array(DesignDimension).default([]),
  })
  .strict();
export type DesignContractV1 = z.infer<typeof DesignContractV1>;

// Parse an UNKNOWN blob (e.g. the persisted jsonb) back through the schema. Throws
// LOUDLY on a malformed/legacy-shaped contract (no silent degrade), exactly like
// the template-manifest parser — a mangled contract never reaches injection.
export function parseDesignContract(value: unknown): DesignContractV1 {
  return DesignContractV1.parse(value);
}

// Serialize a contract to a plain JSON object for the jsonb column. A round-trip
// through the schema is identity by construction (no transient fields).
export function designContractToJson(contract: DesignContractV1): Record<string, unknown> {
  return DesignContractV1.parse(contract) as Record<string, unknown>;
}
