// P3-0015 greenfield onboarding: typed contracts for the vision interview.
//
// The greenfield "full track" is a multi-round Forge VISION INTERVIEW. Across
// ~14 rounds Forge asks the operator about their product and accumulates a
// structured CAPTURE — identity, personas, behaviors, interfaces, design-DNA,
// architecture, rulesets. On completion the capture is DERIVED into the live
// product graph: a project's personas/behaviors/milestones/specs, created
// through the SAME P2A-0018/0013 entity-creation paths so authz + dependency
// checks are unchanged. The derived DAG then renders via P3-0013.
//
// The interview itself runs over the SAME injectable answerer seam as the
// P3-0010 conversation + P3-0014 discovery flows: the real implementation
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
    repoHint: z.string().max(200).default("")
  })
  .strict();
export type CaptureIdentity = z.infer<typeof CaptureIdentity>;

// A persona the interview surfaced. `surface` notes their delivery surface
// (desktop / handheld / …) for the architecture step; purely descriptive.
export const CapturePersona = z
  .object({
    name: z.string().min(1).max(80),
    description: z.string().min(1).max(280),
    surface: z.string().max(80).default("")
  })
  .strict();
export type CapturePersona = z.infer<typeof CapturePersona>;

/* eslint-disable unicorn/no-thenable */
// `then` is BDD Given/When/Then vocabulary (mirrors the P2A-0018 BehaviorRow
// field name); the thenable-object lint does not apply to a schema field.
export const CaptureBehavior = z
  .object({
    persona: z.string().min(1).max(80),
    title: z.string().min(1).max(160),
    given: z.string().max(280).default(""),
    when: z.string().max(280).default(""),
    then: z.string().max(280).default("")
  })
  .strict();
/* eslint-enable unicorn/no-thenable */
export type CaptureBehavior = z.infer<typeof CaptureBehavior>;

// An inferred interface (a delivery surface, e.g. "desktop dashboard").
export const CaptureInterface = z
  .object({
    name: z.string().min(1).max(120),
    note: z.string().max(200).default("")
  })
  .strict();
export type CaptureInterface = z.infer<typeof CaptureInterface>;

// One architecture line ("web · next.js · turborepo"). Free-form by design.
export const CaptureArchitectureLine = z
  .object({
    layer: z.string().min(1).max(40),
    choice: z.string().min(1).max(160)
  })
  .strict();
export type CaptureArchitectureLine = z.infer<typeof CaptureArchitectureLine>;

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
    rulesets: z.array(z.string().min(1)).default([])
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
    rulesets: []
  };
}

// ── Round I/O ───────────────────────────────────────────────────────────────

// One inline suggestion Forge offers under a question (the hi-fi InlineActions).
export const InterviewSuggestion = z
  .object({
    label: z.string().min(1).max(80),
    value: z.string().min(1).max(200)
  })
  .strict();
export type InterviewSuggestion = z.infer<typeof InterviewSuggestion>;

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
    captureDelta: InterviewCapture.partial().default({}),
    suggestions: z.array(InterviewSuggestion).max(4).default([]),
    complete: z.boolean().default(false)
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

// The injectable interview answerer — the LLM seam, mirroring P3-0010's
// `ForgeConversationAnswerer` + P3-0014's `DiscoveryAnswerer`. The real
// implementation wraps a provider Answerer; tests inject a fake; the
// deterministic default keeps the flow live without provider infra.
export interface InterviewAnswerer {
  ask(context: InterviewAnswererContext): Promise<InterviewRoundOutput>;
}

// The default round budget (the hi-fi "round N of ~14").
export const DEFAULT_TOTAL_ROUNDS = 14;
