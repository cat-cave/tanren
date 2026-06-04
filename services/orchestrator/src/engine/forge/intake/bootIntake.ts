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
import { buildForgeAuditAnswererFactory, buildForgeTriageAnswererFactory } from "../providerFactory.js";
import { AuditSchedulerLoop, createAnswererPassRunner } from "../audits/index.js";
import { IntakePoller } from "./poller.js";
import { intakeAutoRouteDeps } from "./systemActor.js";

export interface BootIntakeDeps {
  pool: pg.Pool;
  secrets: SecretStore;
  allocator: Allocator;
  ssh: SshSubstrate;
  githubHttp: GitHubHttpClient;
  // The shared App-token minter: the poller's per-org GitHub issues connector mints an
  // installation token (App-only intake), and the audit pass runner resolves a repo-read token.
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
  const forgeInfra = {
    pool: deps.pool,
    secrets: deps.secrets,
    allocator: deps.allocator,
    ssh: deps.ssh,
    identitySecretRef: deps.identitySecretRef,
  };
  const triageFactory = buildForgeTriageAnswererFactory(forgeInfra);
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
    // The REAL read-only pass runner: it resolves the project's repo, indexes it
    // READ-ONLY, and has the audit answerer surface findings (§8a — no silent
    // empty pass; a repo-less job or a missing credential is a LOUD failure).
    passRunner: createAnswererPassRunner({
      pool: deps.pool,
      secrets: deps.secrets,
      githubHttp: deps.githubHttp,
      ...(deps.githubAppMinter === undefined ? {} : { githubAppMinter: deps.githubAppMinter }),
      answererFactory: buildForgeAuditAnswererFactory(forgeInfra),
    }),
    // An emitted finding triages through the real provider answerer.
    answererFactory: triageFactory,
    // Auto-route a finding's spec into the DAG (the autonomous loop).
    autoRoute,
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
