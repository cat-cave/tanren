// greenfield onboarding: typed contracts for the vision interview.
//
// The greenfield "full track" is a multi-round Forge VISION INTERVIEW. Across
// ~14 rounds Forge asks the operator about their product and accumulates a
// structured CAPTURE — identity, personas, behaviors, interfaces, design-DNA,
// architecture, rulesets. On completion the capture is DERIVED into the live
// product graph: a project's personas/behaviors/milestones/specs, created
// through the SAME entity-creation paths so authz + dependency
// checks are unchanged. The derived DAG then renders via.
//
// The interview itself runs over the SAME injectable answerer seam as the
// conversation + discovery flows: the real implementation
// wraps a provider Answerer; tests inject a fake; a deterministic fallback
// keeps the flow live without provider infra. NOTHING here is persisted — the
// capture is carried round-to-round on the request (the surface re-submits the
// running capture), so there is no interview-session table and no migration.

import { z } from "zod";

// ── Capture sub-shapes (the "what forge captured" panel) ────────────────────

// The product identity: slug + one-line pitch (+ optional repo hint).
export const CaptureIdentity = z
  .object({
    slug: z.string().min(1).max(80),
    pitch: z.string().min(1).max(400),
    repoHint: z.string().max(200).default(""),
  })
  .strict();
export type CaptureIdentity = z.infer<typeof CaptureIdentity>;

// A persona the interview surfaced. `surface` notes their delivery surface
// (desktop / handheld / …) for the architecture step; purely descriptive.
export const CapturePersona = z
  .object({
    name: z.string().min(1).max(80),
    description: z.string().min(1).max(280),
    surface: z.string().max(80).default(""),
  })
  .strict();
export type CapturePersona = z.infer<typeof CapturePersona>;

/* eslint-disable unicorn/no-thenable */
// `then` is BDD Given/When/Then vocabulary (mirrors the BehaviorRow
// field name); the thenable-object lint does not apply to a schema field.
export const CaptureBehavior = z
  .object({
    persona: z.string().min(1).max(80),
    title: z.string().min(1).max(160),
    given: z.string().max(280).default(""),
    when: z.string().max(280).default(""),
    then: z.string().max(280).default(""),
  })
  .strict();
/* eslint-enable unicorn/no-thenable */
export type CaptureBehavior = z.infer<typeof CaptureBehavior>;

// An inferred interface (a delivery surface, e.g. "desktop dashboard").
export const CaptureInterface = z
  .object({
    name: z.string().min(1).max(120),
    note: z.string().max(200).default(""),
  })
  .strict();
export type CaptureInterface = z.infer<typeof CaptureInterface>;

// One architecture line ("web · next.js · turborepo"). Free-form by design —
// the HUMAN-READABLE summary of the architecture step. The LOAD-BEARING output
// of that step is `CaptureLifecycle` below (the concrete stack commands the
// scaffold authors the justfile from).
export const CaptureArchitectureLine = z
  .object({
    layer: z.string().min(1).max(40),
    choice: z.string().min(1).max(160),
  })
  .strict();
export type CaptureArchitectureLine = z.infer<typeof CaptureArchitectureLine>;

// The project's CONCRETE LIFECYCLE for the chosen stack — the load-bearing output
// of the architecture step (stack-flexible contract,
// docs/roadmap/stack-flexible-contract.md). Tanren knows NO stack: the project
// DECLARES what each conventional justfile target IS for its stack, and the run
// MATERIALIZES the justfile + `.tanren/ci.yml` from this DETERMINISTICALLY (no LLM,
// no hardcoded pnpm example — the v27 fix; the ci.yml is the skeleton verbatim, the
// justfile the six targets filled from these commands). The six
// conventional targets map 1:1 to the contract's `bootstrap`/`tier-1`/`tier-2`/
// `tier-3`/`build`/`deploy`; each holds the ACTUAL stack command(s) — general
// enough that a Rust project fills `tier1` with "cargo clippy" + `build` with
// "cargo build", a Python project "uv run ruff" + "uv build", a novel
// translation "aspell" + "pandoc … epub", just as naturally as a TS project
// fills "pnpm lint" + "pnpm build". A target may hold a multi-line command
// (newline-joined). `stack` is the human-readable stack/runtime label
// ("ts/pnpm", "rust/cargo", "python/uv", "novel/pandoc") — descriptive only;
// Tanren never branches on it.
export const CaptureLifecycle = z
  .object({
    // The chosen stack/runtime label (descriptive — NOT a switch Tanren reads).
    stack: z.string().min(1).max(120),
    // The conventional targets → the stack commands that fill them.
    bootstrap: z.string().min(1).max(400),
    tier1: z.string().min(1).max(400),
    tier2: z.string().min(1).max(400),
    tier3: z.string().min(1).max(400),
    build: z.string().min(1).max(400),
    deploy: z.string().min(1).max(400),
  })
  .strict();
export type CaptureLifecycle = z.infer<typeof CaptureLifecycle>;

// The full accumulated capture. Every list grows monotonically across rounds;
// the engine de-dupes by a natural key when merging a round's delta.
export const InterviewCapture = z
  .object({
    identity: CaptureIdentity.nullable().default(null),
    personas: z.array(CapturePersona).default([]),
    behaviors: z.array(CaptureBehavior).default([]),
    interfaces: z.array(CaptureInterface).default([]),
    designDna: z.string().max(80).default(""),
    architecture: z.array(CaptureArchitectureLine).default([]),
    // The load-bearing lifecycle declaration (the architecture step's structured
    // output). `null` until the architecture step captures it; the scaffold
    // FAILS LOUD if it is still null at derive (never a silent Node default).
    lifecycle: CaptureLifecycle.nullable().default(null),
    // LIFECYCLE/STACK DRIFT GUARD (apex v28–v31): once the architecture round
    // captures a lifecycle it is OPERATOR-CONFIRMED + PINNED — a later round's LLM
    // answerer must NOT silently re-write the stack label / swap tier commands /
    // drop flags. This flag latches `true` the first round a lifecycle is captured;
    // while it is set, `mergeCapture` PRESERVES the confirmed lifecycle verbatim and
    // a re-emitted-but-different lifecycle is treated as DRIFT (surfaced, not taken)
    // — an actual change requires an EXPLICIT, operator-visible `lifecycleChange`
    // signal on the delta. Carried on the capture (re-submitted each round) so the
    // pin survives the round trip with no interview-session table.
    lifecycleConfirmed: z.boolean().default(false),
    rulesets: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type InterviewCapture = z.infer<typeof InterviewCapture>;

export function emptyCapture(): InterviewCapture {
  return {
    identity: null,
    personas: [],
    behaviors: [],
    interfaces: [],
    designDna: "",
    architecture: [],
    lifecycle: null,
    lifecycleConfirmed: false,
    rulesets: [],
  };
}

// ── Round I/O ───────────────────────────────────────────────────────────────

// One inline suggestion Forge offers under a question (the hi-fi InlineActions).
export const InterviewSuggestion = z
  .object({
    label: z.string().min(1).max(80),
    value: z.string().min(1).max(200),
  })
  .strict();
export type InterviewSuggestion = z.infer<typeof InterviewSuggestion>;

// The capture DELTA a single round contributes. Every field is OPTIONAL (a
// round adds only the items it surfaced) — but because the answerer JSON Schema
// is rendered for OpenAI strict structured-outputs (every key required, optional
// expressed as nullable; see renderAnswererJsonSchema), the model returns `null`
// for the fields it has nothing to add this round. So each field is `.nullish()`
// (accepts present | null | absent), not the plain `.optional()` that
// `InterviewCapture.partial()` would produce (which would REJECT the model's
// `null`). `mergeCapture` treats null exactly like an omitted field.
export const InterviewCaptureDelta = z
  .object({
    identity: CaptureIdentity.nullish(),
    personas: z.array(CapturePersona).nullish(),
    behaviors: z.array(CaptureBehavior).nullish(),
    interfaces: z.array(CaptureInterface).nullish(),
    designDna: z.string().max(80).nullish(),
    architecture: z.array(CaptureArchitectureLine).nullish(),
    lifecycle: CaptureLifecycle.nullish(),
    // LIFECYCLE/STACK DRIFT GUARD: the EXPLICIT operator-visible signal that a
    // re-emitted `lifecycle` is an INTENTIONAL change to an already-confirmed
    // lifecycle (not silent drift). Only when `true` does `mergeCapture` accept a
    // different lifecycle over a confirmed one; otherwise a differing lifecycle is
    // DRIFT and the confirmed one is preserved. Has no effect on the first (initial)
    // lifecycle capture — that always lands. `null`/absent = no change requested.
    lifecycleChange: z.boolean().nullish(),
    rulesets: z.array(z.string().min(1)).nullish(),
  })
  .strict();
export type InterviewCaptureDelta = z.infer<typeof InterviewCaptureDelta>;

// What the answerer returns for a single round: the next question (or, when the
// interview is complete, a closing line), the capture DELTA this round added,
// and whether the interview is done.
export const InterviewRoundOutput = z
  .object({
    // The Forge prompt/question for the NEXT round (or the closing summary when
    // `complete`).
    say: z.string().min(1).max(2000),
    // The capture this round contributes. The engine merges it into the running
    // capture (monotonic) — the answerer need only return the new items.
    captureDelta: InterviewCaptureDelta.default({}),
    suggestions: z.array(InterviewSuggestion).max(4).default([]),
    complete: z.boolean().default(false),
  })
  .strict();
export type InterviewRoundOutput = z.infer<typeof InterviewRoundOutput>;

// The context handed to the answerer for one round. `round` is 1-based.
export interface InterviewAnswererContext {
  round: number;
  totalRounds: number;
  // The operator's answer to the PRIOR round's question (empty on round 1).
  answer: string;
  // The capture accumulated so far (before this round's delta).
  capture: InterviewCapture;
}

// The injectable interview answerer — the LLM seam, mirroring the conversation answerer's
// `ForgeConversationAnswerer` + the `DiscoveryAnswerer`. The real
// implementation wraps a provider Answerer; tests inject a fake; the
// deterministic default keeps the flow live without provider infra.
export interface InterviewAnswerer {
  ask(context: InterviewAnswererContext): Promise<InterviewRoundOutput>;
}

// The default round budget (the hi-fi "round N of ~14").
export const DEFAULT_TOTAL_ROUNDS = 14;
