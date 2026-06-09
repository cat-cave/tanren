// greenfield onboarding: the vision-interview engine.
//
// Two operations, mirroring the discovery engine shape:
//
//   runRound(deps, input)
//     Runs ONE interview round over the injectable `InterviewAnswerer` (the
//     same seam shape as the conversation answerer — provider in prod,
//     fake in tests, deterministic fallback otherwise). It feeds the answerer
//     the round number + the operator's prior answer + the running capture,
//     then MERGES the returned delta into the capture and returns the next
//     question + the updated capture. NOTHING is persisted — the surface
//     re-submits the running capture each round (pause/resume = stash the
//     capture client-side / on a draft), so there is no interview-session table.
//
//   deriveFromCapture(deps, input)
//     On completion, turns the accumulated capture into a live project's
//     product graph through the existing entity-creation paths (see
//     `derive.ts`). Returns the new project + the derived spec/entity ids; the
//     DAG is then read back via `getProjectDag`.

import type pg from "pg";
import type { ActorContext } from "../../../auth/schemas.js";
import { mergeCapture } from "./capture.js";
import type { CreatedRepository, CreateRepositoryInput } from "../../contracts/vcsProvider.js";
import { deriveProductGraph, type DeriveResult } from "./derive.js";
import type { DeployPreflightCallback, GreenfieldDeployDependency, PrepareDeployCallback } from "./deployDependency.js";
import type { SelectedTemplate, TemplateRegistryQuery } from "./templateSelection.js";
import {
  DEFAULT_TOTAL_ROUNDS,
  InterviewCapture,
  InterviewRoundOutput,
  emptyCapture,
  type CaptureLifecycle,
  type InterviewAnswerer,
  type InterviewRoundOutput as InterviewRoundOutputType,
  type InterviewSuggestion,
} from "./types.js";

export interface InterviewEngineDeps {
  pool: pg.Pool;
  // The interview seam — REQUIRED. Production resolves a real provider answerer
  // from the project's `forge` routing (engine/forge/providerFactory.ts); tests
  // inject a fake/deterministic fixture. There is NO production fallback: a Forge
  // surface that reasons must use a model or hard-fail (§8a).
  answerer: InterviewAnswerer;
  totalRounds?: number;
  preflightDeploy?: DeployPreflightCallback;
  prepareDeploy?: PrepareDeployCallback;
}

export interface RunRoundInput {
  // 1-based round the operator is answering. Round 1 has an empty `answer`.
  round: number;
  answer: string;
  // The capture accumulated so far (the surface re-submits it each round).
  capture: InterviewCapture;
}

export interface RunRoundResult {
  round: number;
  totalRounds: number;
  // Forge's next question (or closing line when `complete`).
  say: string;
  suggestions: InterviewSuggestion[];
  // The capture AFTER merging this round's delta.
  capture: InterviewCapture;
  complete: boolean;
}

export async function runRound(deps: InterviewEngineDeps, input: RunRoundInput): Promise<RunRoundResult> {
  const totalRounds = deps.totalRounds ?? DEFAULT_TOTAL_ROUNDS;
  const priorCapture = InterviewCapture.parse(input.capture);

  const rawOutput = await deps.answerer.ask({
    round: input.round,
    totalRounds,
    answer: input.answer,
    capture: priorCapture,
  });
  // Validate the answerer output at the engine boundary (defence in depth; a
  // provider that drifts from the schema is normalized/rejected here).
  const output: InterviewRoundOutputType = InterviewRoundOutput.parse(rawOutput);

  const nextCapture = mergeCapture(priorCapture, output.captureDelta);
  return {
    round: input.round,
    totalRounds,
    say: output.say,
    suggestions: output.suggestions,
    capture: nextCapture,
    complete: output.complete,
  };
}

export interface DeriveFromCaptureInput {
  orgId: string;
  capture: InterviewCapture;
  actor: ActorContext;
  repoUrl?: string;
  owner?: string;
  private?: boolean;
  description?: string;
  createRepository?: (input: CreateRepositoryInput) => Promise<CreatedRepository>;
  // GREENFIELD AUTONOMY: when `auto`/`simulated`, the derived project is created
  // already autonomous (`native_queue` + the matching review policy); absent or
  // `human` keeps the schema's safe defaults. Threaded into `deriveProductGraph`.
  autonomy?: "auto" | "simulated" | "human";
  deploy?: GreenfieldDeployDependency;
  // TEMPLATING WAVE 3 — the org-scoped template-registry query (templating-system.md
  // §3). When present, the derive SELECTS a validated template to seed from before
  // authoring the scaffold; absent ⇒ the from-scratch path (the current live default).
  templateRegistryQuery?: TemplateRegistryQuery;
  templateChannelPreference?: "lts" | "nightly";
  // TEMPLATING WAVE 4 — the no-match → CREATION seam (templating-system.md §3).
  // When present, selection CREATES a template on no match + seeds from it; absent ⇒
  // from-scratch. Threaded into `deriveProductGraph` (only consulted with a registry
  // query). Supplied by the wiring layer — no creation dependency in this engine.
  createTemplateForNoMatch?: (lifecycle: CaptureLifecycle) => Promise<SelectedTemplate | undefined>;
}

export async function deriveFromCapture(
  // Derivation only needs the pool — it commits an already-accumulated capture
  // through the existing creation paths and consults no answerer.
  deps: Pick<InterviewEngineDeps, "pool" | "preflightDeploy" | "prepareDeploy">,
  input: DeriveFromCaptureInput,
): Promise<DeriveResult> {
  return deriveProductGraph(deps.pool, {
    orgId: input.orgId,
    capture: InterviewCapture.parse(input.capture),
    actor: input.actor,
    ...(input.repoUrl === undefined ? {} : { repoUrl: input.repoUrl }),
    ...(input.owner === undefined ? {} : { owner: input.owner }),
    ...(input.private === undefined ? {} : { private: input.private }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.createRepository === undefined ? {} : { createRepository: input.createRepository }),
    ...(input.autonomy === undefined ? {} : { autonomy: input.autonomy }),
    ...(input.deploy === undefined ? {} : { deploy: input.deploy }),
    ...(input.templateRegistryQuery === undefined ? {} : { templateRegistryQuery: input.templateRegistryQuery }),
    ...(input.createTemplateForNoMatch === undefined
      ? {}
      : { createTemplateForNoMatch: input.createTemplateForNoMatch }),
    ...(input.templateChannelPreference === undefined
      ? {}
      : { templateChannelPreference: input.templateChannelPreference }),
    ...(deps.preflightDeploy === undefined ? {} : { preflightDeploy: deps.preflightDeploy }),
    ...(deps.prepareDeploy === undefined ? {} : { prepareDeploy: deps.prepareDeploy }),
  });
}

export { emptyCapture, DEFAULT_TOTAL_ROUNDS };
export type { DeriveResult };
