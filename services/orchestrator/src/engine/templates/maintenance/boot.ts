// The construction site that boots the TEMPLATE-MAINTENANCE loop (templating-system.md
// §4) — the maintenance analogue of `startIntake` (forge/intake/bootIntake.ts). The
// worker boot calls this once; it assembles the loop's three injected seams and
// starts it:
//   - the REVALIDATOR (`harnessRevalidator`) over the provisioner seam the caller
//     supplies (allocate + clone + bootstrap a registered template's repo, then run
//     the SAME `runValidationHarness`),
//   - the triage answerer FACTORY (the real provider answerer that triages a
//     regression finding — no §8a fallback), and
//   - the auto-route deps (the regression finding re-enters the DAG through the SAME
//     intake auto-route path a scheduled audit uses).
//
// Bundled here so the worker boot carries ONE maintenance dependency (keeping its
// import-dependency count under the cap), exactly as bootIntake.ts does.

import type pg from "pg";
import type { RunStateWriter } from "../../contracts/runStateWriter.js";
import { intakeAutoRouteDeps } from "../../forge/intake/systemActor.js";
import { buildForgeSpecQualityAnswererFactory, buildForgeTriageAnswererFactory } from "../../forge/providerFactory.js";
import type { Allocator } from "../../contracts/allocator.js";
import type { SecretStore } from "../../contracts/secretStore.js";
import type { CommandSubstrate } from "../../contracts/commandSubstrate.js";
import type { TriageAnswerer } from "../../forge/inbox/types.js";
import { TemplateMaintenanceLoop } from "./loop.js";
import { harnessRevalidator, type TemplateWorkspaceProvisioner } from "./revalidator.js";

export interface BootTemplateMaintenanceDeps {
  pool: pg.Pool;
  secrets: SecretStore;
  allocator: Allocator;
  ssh: CommandSubstrate;
  identitySecretRef: string;
  // The provisioner that checks out + bootstraps a registered template's repo onto a
  // runner (the worker-boot impl owns allocate/clone/bootstrap; the harness consumes it).
  provisioner: TemplateWorkspaceProvisioner;
  // Plane-split: when wired, the regression finding's spec INSERT routes through the
  // control plane (else direct on the pool, byte-identical) — mirrors bootIntake.
  runStateWriter?: RunStateWriter;
  // The clock (injected; no Date.now in the loop).
  now?: () => Date;
  // Optional overrides for the maintenance horizons (default in freshness/graduation).
  freshnessHorizonMs?: number;
  graduationAgingMs?: number;
}

export interface BootedTemplateMaintenance {
  loop: TemplateMaintenanceLoop;
  stop: () => void;
}

/**
 * Build + start the template-maintenance loop. The triage answerer + auto-route are
 * assembled exactly as the intake/audit loops do (a runner allocated per model call,
 * the spec-quality gate over every auto-routed spec), so a regression finding becomes
 * a real, validated DAG spec with no operator. Returns the handle so the worker boot's
 * `stop()` drains it.
 */
export function startTemplateMaintenance(deps: BootTemplateMaintenanceDeps): BootedTemplateMaintenance {
  const now = deps.now ?? (() => new Date());
  const forgeInfra = {
    pool: deps.pool,
    secrets: deps.secrets,
    allocator: deps.allocator,
    ssh: deps.ssh,
    identitySecretRef: deps.identitySecretRef,
  };
  const triageFactory = buildForgeTriageAnswererFactory(forgeInfra);
  const specQualityFactory = buildForgeSpecQualityAnswererFactory(forgeInfra);
  const autoRoute = intakeAutoRouteDeps({
    ...(deps.runStateWriter !== undefined && { runStateWriter: deps.runStateWriter }),
    resolveSpecValidator: (target) => specQualityFactory(target),
  });

  const loop = new TemplateMaintenanceLoop({
    pool: deps.pool,
    revalidator: harnessRevalidator({ provisioner: deps.provisioner, now }),
    answererFactory: (target: { orgId: string; projectId?: string }): TriageAnswerer => triageFactory(target),
    autoRoute,
    ...(deps.freshnessHorizonMs !== undefined && { freshnessHorizonMs: deps.freshnessHorizonMs }),
    ...(deps.graduationAgingMs !== undefined && { graduationAgingMs: deps.graduationAgingMs }),
    now: () => now().getTime(),
  });
  loop.start();

  return { loop, stop: () => loop.stop() };
}
