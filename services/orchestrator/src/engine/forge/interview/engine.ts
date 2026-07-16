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
import type {
  DeployPreflightCallback,
  GreenfieldDeployDependency,
  PersistDeploySelectionCallback,
  PrepareDeployCallback,
} from "./deployDependency.js";
import type { DeleteRepositoryCallback, DestroyDeployAppCallback } from "./deriveCompensation.js";
import type { FragmentAuthoring, FragmentLibrary, MaterializeTemplate } from "../../templates/fragments/index.js";
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

  // LIFECYCLE/STACK DRIFT GUARD.
  const lifecycle = resolveLifecycle(priorCapture, output.captureDelta);
  const nextCapture = mergeCapture(priorCapture, output.captureDelta);
  let lifecycleDrift: LifecycleDriftNotice | undefined;
  if (lifecycle.outcome === "drift") {
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
  // COMPENSATION (task #78 — derive atomic rollback). Threaded into
  // `deriveProductGraph` so the derive registers a rollback for each just-created
  // repo + walks them all back if a later step throws. Required in production
  // whenever `createRepository`/`materializeTemplate` are wired.
  deleteRepository?: DeleteRepositoryCallback;
  // GREENFIELD RE-ATTACH GUARD (apex v84). Threaded into `deriveProductGraph` so the
  // re-attach branch can probe whether an already-existing repo is a bare auto_init
  // seed (safe to re-attach) vs one already carrying a prior run's compose history
  // (fail loud — never silently reuse). Wired against `CodeHost.isRepoBareAutoInit`.
  probeRepoBareAutoInit?: (target: { owner: string; name: string }) => Promise<boolean>;
  // GREENFIELD AUTONOMY: when `auto`/`simulated`, the derived project is created
  // already autonomous — atomically with `native_queue` + the matching review
  // policy + `AUTONOMOUS_AUDIT_POSTURE` + `insightThresholds.ciInsightFlakyMinShas:1`
  // (task #79: every knob autonomous operation requires lands at project insert, so
  // the DagWalker auto-claim cannot observe a partially-configured project). Absent
  // or `human` keeps the schema's safe defaults. Threaded into `deriveProductGraph`.
  autonomy?: "auto" | "simulated" | "human";
  deploy?: GreenfieldDeployDependency;
  persistDeploySelection?: PersistDeploySelectionCallback;
  // COMPENSATION (task #78 — derive atomic rollback). Threaded into
  // `deriveProductGraph` so the derive registers a rollback for the provisioned
  // deploy app + destroys it if a later step throws. Required in production
  // whenever `prepareDeploy` is wired.
  destroyDeployApp?: DestroyDeployAppCallback;
  // The COMPOSE+MATERIALIZE seam (docs/roadmap/templating-system.md). Every
  // greenfield derive composes a fragment-based template from the captured
  // lifecycle and materializes it into a fresh seed repo via this seam.
  materializeTemplate?: MaterializeTemplate;
  // Override the fragment library (unified bundled + org-scoped). When omitted,
  // the bundled library is used.
  fragmentLibrary?: FragmentLibrary;
  // Per-fragment authoring seam (F2). On a missing-fragments decision the derive
  // calls this to author the missing fragments, persist them, and retry.
  runFragmentAuthoring?: FragmentAuthoring;
  // WS-D3 (native-design-subsystem.md): the DESIGN AGENT that elaborates the captured
  // design intent into the designed HEAD `DesignContract`.
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
    ...(input.deleteRepository === undefined ? {} : { deleteRepository: input.deleteRepository }),
    ...(input.probeRepoBareAutoInit === undefined ? {} : { probeRepoBareAutoInit: input.probeRepoBareAutoInit }),
    ...(input.autonomy === undefined ? {} : { autonomy: input.autonomy }),
    ...(input.deploy === undefined ? {} : { deploy: input.deploy }),
    ...(input.persistDeploySelection === undefined ? {} : { persistDeploySelection: input.persistDeploySelection }),
    ...(input.destroyDeployApp === undefined ? {} : { destroyDeployApp: input.destroyDeployApp }),
    ...(input.materializeTemplate === undefined ? {} : { materializeTemplate: input.materializeTemplate }),
    ...(input.fragmentLibrary === undefined ? {} : { fragmentLibrary: input.fragmentLibrary }),
    ...(input.runFragmentAuthoring === undefined ? {} : { runFragmentAuthoring: input.runFragmentAuthoring }),
    ...(deps.preflightDeploy === undefined ? {} : { preflightDeploy: deps.preflightDeploy }),
    ...(deps.prepareDeploy === undefined ? {} : { prepareDeploy: deps.prepareDeploy }),
    ...(input.designAgent === undefined ? {} : { designAgent: input.designAgent }),
  });
}

export { emptyCapture, DEFAULT_TOTAL_ROUNDS };
export type { DeriveResult };
