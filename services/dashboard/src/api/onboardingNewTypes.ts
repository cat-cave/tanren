/**
 * greenfield-onboarding client types — the dashboard-side mirror of the
 * orchestrator's `engine/forge/interview` contracts. Kept in their own module
 * (the discovery isolation lesson: parallel client-touching screens own their
 * own api modules so they never diverge a shared client).
 */

export interface CaptureIdentity {
  slug: string;
  pitch: string;
  repoHint: string;
}

export interface CapturePersona {
  name: string;
  description: string;
  surface: string;
}

export interface CaptureBehavior {
  persona: string;
  title: string;
  given: string;
  when: string;
  then: string;
}

export interface CaptureInterface {
  name: string;
  note: string;
}

export interface CaptureArchitectureLine {
  layer: string;
  choice: string;
}

// The project's concrete lifecycle — the load-bearing output of the architecture
// step (the stack commands behind the six conventional justfile targets the
// scaffold authors from). `null` until the architecture step captures it.
export interface CaptureLifecycle {
  stack: string;
  bootstrap: string;
  tier1: string;
  tier2: string;
  tier3: string;
  build: string;
  deploy: string;
}

// One domain-adaptive design dimension (native design subsystem, WS-D1) — the
// client mirror of the orchestrator's `CaptureDesignDimension`. `personas` are the
// persona names whose view this dimension describes (persona-scoped design).
export interface CaptureDesignDimension {
  key: string;
  label: string;
  intent: string;
  guidance: string;
  personas: string[];
}

// The captured DESIGN CONTRACT (native design subsystem, WS-D1) — supersedes the
// decorative 80-char `designDna` hint. A domain-general design-intent contract:
// a typed core + a domain-adaptive dimension set + FIRST-CLASS persona/behavior
// links (`personas` by name, `behaviors` by `persona::title` key — the moat
// binding design to Tanren's native entity graph). `null` until the design step.
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

export interface InterviewCapture {
  identity: CaptureIdentity | null;
  personas: CapturePersona[];
  behaviors: CaptureBehavior[];
  interfaces: CaptureInterface[];
  designContract: CaptureDesignContract | null;
  architecture: CaptureArchitectureLine[];
  lifecycle: CaptureLifecycle | null;
  rulesets: string[];
}

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
  capture: InterviewCapture;
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
    rulesets: [],
  };
}
