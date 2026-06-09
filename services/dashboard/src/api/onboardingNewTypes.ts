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

export interface InterviewCapture {
  identity: CaptureIdentity | null;
  personas: CapturePersona[];
  behaviors: CaptureBehavior[];
  interfaces: CaptureInterface[];
  designDna: string;
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

export function emptyCapture(): InterviewCapture {
  return {
    identity: null,
    personas: [],
    behaviors: [],
    interfaces: [],
    designDna: "",
    architecture: [],
    lifecycle: null,
    rulesets: [],
  };
}
