/**
 * greenfield-onboarding client types — the dashboard-side mirror of the
 * orchestrator's `engine/forge/interview` contracts. Kept in their own module
 * (the discovery isolation lesson: parallel client-touching screens own their
 * own api modules so they never diverge a shared client).
 */

import { z } from "zod";

const CaptureIdentitySchema = z
  .object({
    slug: z.string(),
    pitch: z.string(),
    repoHint: z.string(),
  })
  .strict();
export interface CaptureIdentity {
  slug: string;
  pitch: string;
  repoHint: string;
}

const CapturePersonaSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    surface: z.string(),
  })
  .strict();
export interface CapturePersona {
  name: string;
  description: string;
  surface: string;
}

const CaptureBehaviorSchema = z
  .object({
    persona: z.string(),
    title: z.string(),
    given: z.string(),
    when: z.string(),
    // eslint-disable-next-line unicorn/no-thenable -- `then` is the BDD field in the API contract.
    ["then"]: z.string(),
  })
  .strict();
export interface CaptureBehavior {
  persona: string;
  title: string;
  given: string;
  when: string;
  then: string;
}

const CaptureInterfaceSchema = z
  .object({
    name: z.string(),
    note: z.string(),
  })
  .strict();
export interface CaptureInterface {
  name: string;
  note: string;
}

const CaptureArchitectureLineSchema = z
  .object({
    layer: z.string(),
    choice: z.string(),
  })
  .strict();
export interface CaptureArchitectureLine {
  layer: string;
  choice: string;
}

const CaptureLifecycleSchema = z
  .object({
    stack: z.string(),
    bootstrap: z.string(),
    tier1: z.string(),
    tier2: z.string(),
    tier3: z.string(),
    build: z.string(),
    deploy: z.string(),
    upgrade: z.string(),
    toolchain: z.array(z.object({ name: z.string(), version: z.string() }).strict()),
  })
  .strict();
export interface CaptureLifecycle {
  stack: string;
  bootstrap: string;
  tier1: string;
  tier2: string;
  tier3: string;
  build: string;
  deploy: string;
  upgrade: string;
  toolchain: { name: string; version: string }[];
}

const CaptureDesignDimensionSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    intent: z.string(),
    guidance: z.string(),
    personas: z.array(z.string()),
  })
  .strict();
export interface CaptureDesignDimension {
  key: string;
  label: string;
  intent: string;
  guidance: string;
  personas: string[];
}

const CaptureDesignContractSchema = z
  .object({
    domain: z.string(),
    identity: z.string(),
    intent: z.string(),
    principles: z.array(z.string()),
    constraints: z.array(z.string()),
    personas: z.array(z.string()),
    behaviors: z.array(z.string()),
    dimensions: z.array(CaptureDesignDimensionSchema),
  })
  .strict();
export interface CaptureDesignContract {
  domain: string;
  identity: string;
  intent: string;
  principles: string[];
  constraints: string[];
  personas: string[];
  behaviors: string[];
  dimensions: CaptureDesignDimension[];
}

export const InterviewCaptureSchema = z
  .object({
    identity: CaptureIdentitySchema.nullable(),
    personas: z.array(CapturePersonaSchema),
    behaviors: z.array(CaptureBehaviorSchema),
    interfaces: z.array(CaptureInterfaceSchema),
    designContract: CaptureDesignContractSchema.nullable(),
    architecture: z.array(CaptureArchitectureLineSchema),
    lifecycle: CaptureLifecycleSchema.nullable(),
    lifecycleConfirmed: z.boolean(),
    rulesets: z.array(z.string()),
  })
  .strict();

// The project's concrete lifecycle — the load-bearing output of the architecture
// step (the stack commands behind the six conventional justfile targets the
// scaffold authors from). `null` until the architecture step captures it.

// One domain-adaptive design dimension (native design subsystem, WS-D1) — the
// client mirror of the orchestrator's `CaptureDesignDimension`. `personas` are the
// persona names whose view this dimension describes (persona-scoped design).

// The captured DESIGN CONTRACT (native design subsystem, WS-D1) — supersedes the
// decorative 80-char `designDna` hint. A domain-general design-intent contract:
// a typed core + a domain-adaptive dimension set + FIRST-CLASS persona/behavior
// links (`personas` by name, `behaviors` by `persona::title` key — the moat
// binding design to Tanren's native entity graph). `null` until the design step.
export type InterviewCapture = z.infer<typeof InterviewCaptureSchema> & {
  identity: CaptureIdentity | null;
  personas: CapturePersona[];
  behaviors: CaptureBehavior[];
  interfaces: CaptureInterface[];
  designContract: CaptureDesignContract | null;
  architecture: CaptureArchitectureLine[];
  lifecycle: CaptureLifecycle | null;
};

export interface InterviewSuggestion {
  label: string;
  value: string;
}

export interface InterviewRoundResult {
  round: number;
  totalRounds: number;
  say: string;
  suggestions: InterviewSuggestion[];
  capture: InterviewCapture;
  state: string;
  complete: boolean;
}

export interface DeriveResult {
  projectId: string;
  projectName: string;
  specIds: string[];
  personaIds: string[];
  behaviorIds: string[];
  milestoneIds: string[];
}

// GREENFIELD AUTONOMY mode for a derive (mirrors the orchestrator DeriveBody
// `autonomy` enum). `auto`/`simulated` land the project already autonomous so the
// DagWalker advances off the empty repo with no follow-up PATCH; `human` keeps
// the safe review-gated default.
export type DeriveAutonomy = "auto" | "simulated" | "human";

// A linked deploy provider selection for a greenfield derive — the client mirror
// of the orchestrator `GreenfieldDeploySchema` subset the UI collects. Only the
// two supported provider kinds; connection/grant travel together (a linked grant
// carries both) so the server's paired-field refinement is satisfied.
export interface DeriveDeployInput {
  providerKind: "deploy.vercel" | "deploy.flyio";
  connectionId?: string;
  grantId?: string;
}

// The full derive payload the greenfield UI sends. `owner` (the GitHub owner for
// the new repo) is REQUIRED by the orchestrator's strict `DeriveBody`; omitting it
// is what returned the raw 400 the UI now guards against before submit.
export interface DeriveInput {
  state: string;
  owner: string;
  autonomy?: DeriveAutonomy;
  deploy?: DeriveDeployInput;
}

export function emptyCapture(): InterviewCapture {
  return {
    identity: null,
    personas: [],
    behaviors: [],
    interfaces: [],
    designContract: null,
    architecture: [],
    lifecycle: null,
    lifecycleConfirmed: false,
    rulesets: [],
  };
}

/** Decode only for rendering; the orchestrator still verifies the HMAC before use. */
export function decodeInterviewStateForDisplay(raw: string): { capture: InterviewCapture } | undefined {
  const encoded = raw.split(".")[0];
  if (encoded === undefined || encoded === "") return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    const state = z
      .object({ kind: z.literal("interview"), capture: InterviewCaptureSchema })
      .passthrough()
      .safeParse(parsed);
    return state.success ? { capture: state.data.capture } : undefined;
  } catch {
    return undefined;
  }
}
