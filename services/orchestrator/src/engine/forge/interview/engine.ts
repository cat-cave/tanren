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
import { mergeCapture, resolveLifecycle } from "./capture.js";
import type { CreatedRepository, CreateRepositoryInput } from "../../contracts/codeHostTypes.js";
import type { DesignAgent } from "../../design/designAgent.js";
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
import { createLogger } from "../../observability/logger.js";

const log = createLogger("interview");

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

// LIFECYCLE/STACK DRIFT GUARD: when a round's answerer tried to OVERWRITE the
// operator-confirmed lifecycle with a DIFFERENT one but did NOT flag it as an
// explicit change, the merge REJECTS the drift (preserves the confirmed lifecycle)
// and reports it here so it is OPERATOR-VISIBLE (surfaced on the round result +
// logged loudly), never silently swallowed. `kind` distinguishes a rejected silent
// drift from an accepted explicit change (both are surfaced; only `drift` is a
// rejection). Absent on rounds that touched no lifecycle / the initial capture.
export interface LifecycleDriftNotice {
  kind: "drift" | "changed";
  // The lifecycle now in effect (the confirmed one on `drift`; the new one on `changed`).
  effective: CaptureLifecycle;
  // What the answerer tried to set (the rejected drift, or the accepted change).
  attempted: CaptureLifecycle;
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
  // Present only when this round attempted to mutate the confirmed lifecycle (a
  // rejected silent drift, or an accepted explicit change) — surfaced so the
  // operator sees it. Omitted otherwise.
  lifecycleDrift?: LifecycleDriftNotice;
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

  // LIFECYCLE/STACK DRIFT GUARD: resolve the lifecycle BEFORE the merge so a
  // rejected silent drift (or an accepted explicit change) is surfaced + logged
  // loudly — never swallowed. The merge itself preserves the confirmed lifecycle.
  const lifecycle = resolveLifecycle(priorCapture, output.captureDelta);
  const nextCapture = mergeCapture(priorCapture, output.captureDelta);
  let lifecycleDrift: LifecycleDriftNotice | undefined;
  if (lifecycle.outcome === "drift") {
    // LOUD: an answerer tried to drift the operator's confirmed stack. The
    // confirmed lifecycle is preserved verbatim; the attempt is reported.
    log.warn(
      "REJECTED lifecycle drift — the answerer tried to overwrite the operator-confirmed stack without an " +
        "explicit change. Preserving the confirmed lifecycle.",
      { round: input.round, confirmedStack: lifecycle.lifecycle.stack, attemptedStack: lifecycle.attempted.stack },
    );
    lifecycleDrift = { kind: "drift", effective: lifecycle.lifecycle, attempted: lifecycle.attempted };
  } else if (lifecycle.outcome === "changed") {
    log.warn("EXPLICIT lifecycle change — the operator-confirmed stack changed via explicit signal", {
      round: input.round,
      stack: lifecycle.lifecycle.stack,
    });
    lifecycleDrift = { kind: "changed", effective: lifecycle.lifecycle, attempted: lifecycle.lifecycle };
  }
  return {
    round: input.round,
    totalRounds,
    say: output.say,
    suggestions: output.suggestions,
    capture: nextCapture,
    complete: output.complete,
    ...(lifecycleDrift === undefined ? {} : { lifecycleDrift }),
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
  // The scaffold ORIGIN (templating-system.md §3). "project" (default) ALWAYS runs
  // template selection (a registry query is required); "template_build" is the
  // creation BUILD step that authors the template from scratch. Threaded into
  // `deriveProductGraph` so the doctrine invariant (no project DAG scaffolds against a
  // non-template base) is enforced there.
  scaffoldOrigin?: "project" | "template_build";
  // The org-scoped template-registry query (templating-system.md §3). REQUIRED on the
  // "project" origin (a project ALWAYS selects a validated template to seed from);
  // absent only on the "template_build" origin (which authors the template itself).
  templateRegistryQuery?: TemplateRegistryQuery;
  templateChannelPreference?: "lts" | "nightly";
  // Injectable clock for deterministic selection-freshness (threaded to selection).
  selectionNow?: number;
  // The no-match → JUST-IN-TIME CREATION seam (templating-system.md §3). On a no-match
  // selection CREATES a validated template + seeds from it; an un-creatable no-match
  // HALTS LOUD. Threaded into `deriveProductGraph` (consulted only with a registry
  // query). Supplied by the wiring layer — no creation dependency in this engine.
  createTemplateForNoMatch?: (lifecycle: CaptureLifecycle) => Promise<SelectedTemplate | undefined>;
  // WS-D3 (native-design-subsystem.md): the DESIGN AGENT that elaborates the captured
  // design intent into the designed HEAD `DesignContract` (the design phase) before
  // the build nodes run. Production wires a real provider answerer; absent ⇒ the thin
  // captured contract is persisted verbatim. Threaded into `deriveProductGraph`.
  designAgent?: DesignAgent;
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
    ...(input.scaffoldOrigin === undefined ? {} : { scaffoldOrigin: input.scaffoldOrigin }),
    ...(input.selectionNow === undefined ? {} : { selectionNow: input.selectionNow }),
    ...(input.templateRegistryQuery === undefined ? {} : { templateRegistryQuery: input.templateRegistryQuery }),
    ...(input.createTemplateForNoMatch === undefined
      ? {}
      : { createTemplateForNoMatch: input.createTemplateForNoMatch }),
    ...(input.templateChannelPreference === undefined
      ? {}
      : { templateChannelPreference: input.templateChannelPreference }),
    ...(deps.preflightDeploy === undefined ? {} : { preflightDeploy: deps.preflightDeploy }),
    ...(deps.prepareDeploy === undefined ? {} : { prepareDeploy: deps.prepareDeploy }),
    ...(input.designAgent === undefined ? {} : { designAgent: input.designAgent }),
  });
}

export { emptyCapture, DEFAULT_TOTAL_ROUNDS };
export type { DeriveResult };
