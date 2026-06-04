// CI-intelligence PR3 — the CiInsightsLoop construction site, extracted so
// `autonomyLoops.ts` carries ONE import for the loop (keeping its runtime-import
// count under the cap; precedent: `buildDeployOnMergeWatcher`). It assembles the
// loop's GENERATIVE arm — the real provider triage answerer factory (the SAME
// `buildForgeTriageAnswererFactory` the intake poller + audit scheduler use, so the
// root-cause triage reasons with a model, no §8a fallback) + the autonomous
// DAG-insert deps (system actor, plane-split-aware) — and returns a STARTED loop.

import type pg from "pg";
import type { Allocator } from "../contracts/allocator.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { SshSubstrate } from "../contracts/sshSubstrate.js";
import { buildForgeTriageAnswererFactory } from "../forge/providerFactory.js";
import { intakeAutoRouteDeps } from "../forge/intake/systemActor.js";
import { CiInsightsLoop } from "./ciInsightsLoop.js";

export interface BuildCiInsightsLoopDeps {
  pool: pg.Pool;
  secrets: SecretStore;
  allocator: Allocator;
  ssh: SshSubstrate;
  identitySecretRef: string;
  /** Plane-split: routes the generated candidate's spec INSERT through the control plane when wired. */
  runStateWriter?: RunStateWriter;
}

/** Build + start the CI-insights loop (detect+quarantine PR2 · generate-fix PR3). */
export function buildCiInsightsLoop(deps: BuildCiInsightsLoopDeps): CiInsightsLoop {
  const triageFactory = buildForgeTriageAnswererFactory({
    pool: deps.pool,
    secrets: deps.secrets,
    allocator: deps.allocator,
    ssh: deps.ssh,
    identitySecretRef: deps.identitySecretRef,
  });
  const loop = new CiInsightsLoop({
    pool: deps.pool,
    answererFactory: triageFactory,
    autoRoute: intakeAutoRouteDeps(deps.runStateWriter),
  });
  loop.start();
  return loop;
}
