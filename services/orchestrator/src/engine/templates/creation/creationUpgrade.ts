// Template-creation CREATION-TIME UPGRADE (environment-management.md §4.5/§7 P1 —
// "scaffold-time upgrade so new projects start near-latest").
//
// THE GAP this closes: an agent authoring a fresh template pins versions from its
// TRAINING CUTOFF (apex finding: a live run pinned node 24 + pnpm 10 when pnpm 11 was
// current). The research prompt steers latest-by-default (liveResearch.ts), but a model
// cutoff is unavoidable, so a freshly-born template still drifts stale. The ongoing
// upgrade generator (`forge/upgrade/generator.ts`) bumps a LIVING project periodically —
// but a template born today never gets that first bump. This wires the bump in at BIRTH:
// once, at template creation, gated.
//
// HOW (REUSE, never reinvent): this is NOT a side path that mutates lockfiles un-gated.
// It inserts the SAME gated DAG node the periodic generator inserts (`generateUpgradeSpec`
// → `acceptProposals` → the DAG), made to depend on the build's scaffold/feature specs so
// it runs ONLY AFTER the template reaches a green gate (there are deps + a `mise.toml` to
// bump by then). The build driver's existing convergence drive then runs it through the
// full gate like any node:
//   - green → it merges; the template is born at latest.
//   - red   → it routes through the EXISTING write→gate self-heal loop (the writer fixes
//             the bump), NOT a hard fail — the same never-break path as any spec.
// BOUNDED by the build's existing convergence budget — no new unbounded loop.
//
// NO SILENT FALLBACK: a project that declares no `upgrade` verb (or is pinned) SKIPS
// LOUDLY — a durable `template.creation.upgrade_skipped` event — never a hidden no-op.
// STACK-AGNOSTIC: the inserted node runs the project's opaque `just upgrade`; Tanren names
// no bump command here.

import type pg from "pg";
import type { ActorContext } from "../../../auth/schemas.js";
import type { EventStore } from "../../eventStore.js";
import { generateUpgradeSpec, type UpgradeRefusalReason } from "../../forge/upgrade/index.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("template-creation-upgrade");

// The creation-time upgrade seam — injected into the creation flow so the orchestration
// is exercised against a stub (no live DAG/DB) and the real impl wires `generateUpgradeSpec`.
export interface CreationUpgrade {
  // Insert the once-at-birth upgrade node, depending on the build specs (so it runs after
  // the template reaches a green gate). Returns the outcome the flow records as a durable
  // event. NEVER throws on a refusal — a refusal is a LOUD skip, not a failure.
  run(input: CreationUpgradeInput): Promise<CreationUpgradeOutcome>;
}

export interface CreationUpgradeInput {
  orgId: string;
  projectId: string;
  actor: ActorContext;
  // The existing build specs the upgrade node must run after (the scaffold + features).
  dependsOn: ReadonlyArray<string>;
}

export type CreationUpgradeOutcome =
  // The upgrade node was inserted into the build DAG (it runs after the build specs, gated).
  | { kind: "generated"; specId: string }
  // No node — a LOUD skip (the project declares no upgrade verb, or is pinned).
  | { kind: "skipped"; reason: UpgradeRefusalReason };

export interface CreationUpgradeDeps {
  pool: pg.Pool;
}

// Build the production creation-time upgrade. Reuses `generateUpgradeSpec` (the gated
// DAG-node insert), passing the build specs as `dependsOn` so the once-at-birth upgrade
// runs after the template's green gate. The single construction site is `createTemplateFlow`.
export function buildCreationUpgrade(deps: CreationUpgradeDeps): CreationUpgrade {
  return {
    async run(input: CreationUpgradeInput): Promise<CreationUpgradeOutcome> {
      const result = await generateUpgradeSpec(
        { pool: deps.pool },
        {
          orgId: input.orgId,
          projectId: input.projectId,
          actor: input.actor,
          dependsOn: input.dependsOn,
        },
      );
      if (result.kind === "generated") {
        return { kind: "generated", specId: result.specId };
      }
      return { kind: "skipped", reason: result.reason };
    },
  };
}

// Run the creation-time upgrade + emit its DURABLE observability event (never a vanishing
// log). On `generated`: `template.creation.upgraded` carrying the inserted node + the
// before-signal (the build specs it gates behind). On `skipped`: a LOUD
// `template.creation.upgrade_skipped` with the refusal reason — the no-silent-fallback
// guarantee. A bounded, best-effort step: it NEVER fails the creation (a broken upgrade
// self-heals through the build gate; an absent verb skips loud), so any error from the
// insert is logged + treated as a skip, never propagated to abort the build.
export async function runCreationTimeUpgrade(
  upgrade: CreationUpgrade,
  events: EventStore,
  input: CreationUpgradeInput & { stack: string },
): Promise<CreationUpgradeOutcome> {
  let outcome: CreationUpgradeOutcome;
  try {
    outcome = await upgrade.run({
      orgId: input.orgId,
      projectId: input.projectId,
      actor: input.actor,
      dependsOn: input.dependsOn,
    });
  } catch (error) {
    // The creation-time upgrade is a best-effort near-latest nudge, NOT a publish gate:
    // a broken bump self-heals through the build gate, so an insert error must not abort
    // the build. Record it as a LOUD skip (never a silent swallow) and continue.
    log.warn(
      "creation-time upgrade insert FAILED — skipping the once-at-birth bump (the template still " +
        "builds; the ongoing upgrade generator will bump it later)",
      { projectId: input.projectId, stack: input.stack },
      error,
    );
    outcome = { kind: "skipped", reason: "no_upgrade_command" };
  }

  // Best-effort emit: the upgrade event is observability, so an event-store failure must
  // not abort the build (which is the actual product). Swallow after a log.
  try {
    if (outcome.kind === "generated") {
      await events.append({
        projectId: input.projectId,
        eventType: "template.creation.upgraded",
        payload: {
          orgId: input.orgId,
          stack: input.stack,
          specId: outcome.specId,
          // BEFORE signal: the build specs the once-at-birth upgrade gates behind, so the
          // event is legible (this upgrade ran after these specs reached a green gate).
          afterSpecIds: [...input.dependsOn],
        },
      });
    } else {
      // LOUD SKIP (no silent fallback): a project with no upgrade verb / a pinned project
      // gets a durable record that the once-at-birth bump did NOT run, and why.
      await events.append({
        projectId: input.projectId,
        eventType: "template.creation.upgrade_skipped",
        payload: { orgId: input.orgId, stack: input.stack, reason: outcome.reason },
      });
    }
  } catch (error) {
    log.warn(
      "failed to emit creation-time upgrade event (the build proceeds)",
      { projectId: input.projectId, kind: outcome.kind },
      error,
    );
  }
  return outcome;
}
