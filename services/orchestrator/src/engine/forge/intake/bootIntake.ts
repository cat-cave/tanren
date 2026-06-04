// P1d — the single construction site that boots the autonomous-intake background
// loops (autonomy-engine.md §1d): the webhook-fallback POLLER and the
// now-on-a-loop AUDIT SCHEDULER. Bundled here so the worker boot carries ONE
// intake dependency (keeping its import-dependency count under the cap) and the
// poller + audit loop share one assembled triage answerer factory + connector map.

import type pg from "pg";
import type { Allocator } from "../../contracts/allocator.js";
import type { RunStateWriter } from "../../contracts/runStateWriter.js";
import type { SecretStore } from "../../contracts/secretStore.js";
import type { SshSubstrate } from "../../contracts/sshSubstrate.js";
import type { GitHubHttpClient } from "../../providers/github.js";
import type { GithubAppTokenMinter } from "../../providers/githubAppTokenMinter.js";
import { buildForgeTriageAnswererFactory } from "../providerFactory.js";
import { AuditSchedulerLoop, createNoopPassRunner } from "../audits/index.js";
import { IntakePoller } from "./poller.js";
import { intakeAutoRouteDeps } from "./systemActor.js";

export interface BootIntakeDeps {
  pool: pg.Pool;
  secrets: SecretStore;
  allocator: Allocator;
  ssh: SshSubstrate;
  githubHttp: GitHubHttpClient;
  // App-only intake (creds-audit fix): the shared App-token minter, threaded to the
  // poller so its per-org GitHub issues connector mints an installation token.
  githubAppMinter?: GithubAppTokenMinter;
  identitySecretRef: string;
  /**
   * Plane-split (autonomy loops): the control-plane run-state writer. When present
   * (remote-writes on), the intake auto-route's spec INSERT + provenance UPDATE
   * route through the control plane (the de-privileged data plane can no longer
   * write `specs` directly); absent, direct on the pool — byte-identical to today.
   */
  runStateWriter?: RunStateWriter;
}

export interface BootedIntake {
  poller: IntakePoller;
  auditScheduler: AuditSchedulerLoop;
  /** Stop both loops (idempotent). */
  stop: () => void;
}

/**
 * Build + start the intake poller (pull fallback) and the scheduled-audit loop.
 * Both triage with the REAL provider answerer (a runner allocated per model call,
 * exactly as the Forge route factories do) and auto-route an `auto_routable`
 * result into the DAG. Returns the handles so the worker boot's `stop()` drains them.
 */
export function startIntake(deps: BootIntakeDeps): BootedIntake {
  const triageFactory = buildForgeTriageAnswererFactory({
    pool: deps.pool,
    secrets: deps.secrets,
    allocator: deps.allocator,
    ssh: deps.ssh,
    identitySecretRef: deps.identitySecretRef,
  });
  const autoRoute = intakeAutoRouteDeps(deps.runStateWriter);

  const poller = new IntakePoller({
    pool: deps.pool,
    // App-only intake: the poller rebuilds the connector map PER-ORG (resolving each
    // org's App installation), so it carries the transports + minter rather than a
    // single org-agnostic map.
    secrets: deps.secrets,
    githubHttp: deps.githubHttp,
    ...(deps.githubAppMinter === undefined ? {} : { githubAppMinter: deps.githubAppMinter }),
    answererFactory: triageFactory,
    autoRoute,
  });
  poller.start();

  const auditScheduler = new AuditSchedulerLoop({
    pool: deps.pool,
    // No-op pass runner until an SSH-backed pass is wired (§8a: a clean pass is
    // honest absence). An emitted finding triages through the real answerer.
    passRunner: createNoopPassRunner(),
    answererFactory: triageFactory,
  });
  auditScheduler.start();

  return {
    poller,
    auditScheduler,
    stop: () => {
      poller.stop();
      auditScheduler.stop();
    },
  };
}
