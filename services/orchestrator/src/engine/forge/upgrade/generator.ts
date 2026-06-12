// Version-change-as-DAG-node generator (environment-management.md §4.5/§7 P1).
//
// This is the EMBODIMENT of the §4.5 doctrine: a dependency upgrade is NOT a side
// stream that mutates lockfiles and merges un-gated — it is a FIRST-CLASS unit of
// work in the DAG, gated by the same never-break-main `MergeAuthority` path as any
// code change. So `generateUpgradeSpec` GENERATES the work (a spec whose run executes
// the project's `just upgrade`, regenerates the lockfile, and commits) and INSERTS it
// via the EXISTING spec-creation path (`acceptProposals` → `createSpec` → the DAG),
// the SAME hand-off the operator click and the autonomous intake/audit loops use. The
// DagWalker then drives it through tiers → build → gate:
//   - green  → it merges; main moves forward on the new versions, still working.
//   - red    → the gate REJECTS it loudly (this bump breaks these gate steps); main
//              stays green. A breaking pin/downgrade cannot silently land.
//
// There is deliberately NO code path here that touches `package.json`/lockfiles
// directly or merges without the gate. The verb only PRODUCES the change; the DAG +
// gate are what make it SAFE.
//
// The proactive triggers (a scheduled freshness pass, CVE-advisory ingestion) that
// CALL this generator are FOLLOW-ON work (environment-management.md §4.5 motivation 2
// + §6 "Version-change flow"). P1 ships the generator + an operator endpoint
// (`POST /orgs/:orgId/projects/:projectId/upgrade`) that triggers it on demand.

import type pg from "pg";
import type { ActorContext } from "../../../auth/schemas.js";
import { migrateProjectConfig, type ProjectLifecycle, type ProjectUpgradePolicy } from "../../config/index.js";
import { ProjectStore } from "../../repositories/index.js";
import { systemActor } from "../../state/actor.js";
import { acceptProposals, type DiscoveryInsight, type ProposedSpec } from "../discovery/index.js";

// Why a project cannot have a forced-upgrade node generated for it right now. Both are
// SEMANTIC refusals (not errors): the project is intentionally pinned, or it declares no
// upgrade command — Tanren is un-opinionated on version CHOICE (§4.5 motivation 1/4) and
// never invents a dependency-bump command (it owns the policy, not the command).
export type UpgradeRefusalReason =
  // The upgrade policy's `keepCurrent` posture is OFF — the project pins its versions, so
  // Tanren generates no forced-upgrade work (a deliberate pin is intent, not noise).
  | "policy_pinned"
  // The project declares no `upgrade` command (no captured lifecycle, or an empty
  // `lifecycle.upgrade`). There is nothing to run, so no node is generated — emitting a
  // spec that runs a STUB `just upgrade` (`exit 1`) would just churn a guaranteed-red run.
  | "no_upgrade_command";

export type GenerateUpgradeSpecResult =
  // The upgrade node was generated + INSERTED into the DAG via `acceptProposals`. The
  // DagWalker picks it up on its next tick and runs it through the full gate. `specId` is
  // the created spec.
  | { kind: "generated"; specId: string }
  // No node generated — a semantic refusal (see `UpgradeRefusalReason`), never a silent
  // un-gated mutation.
  | { kind: "refused"; reason: UpgradeRefusalReason };

export interface GenerateUpgradeSpecInput {
  orgId: string;
  projectId: string;
  // The actor the spec INSERT is attributed to (RLS-scoped). The operator endpoint
  // passes the request actor; a future scheduled trigger passes a system actor carrying
  // the project's org.
  actor: ActorContext;
}

export interface GenerateUpgradeSpecDeps {
  pool: pg.Pool;
}

// The upgrade spec's stable title + the source label its provenance records. A constant
// so a repeat trigger is recognizable (and a future "one open upgrade node at a time"
// guard can match on it).
export const UPGRADE_SPEC_TITLE = "Upgrade dependencies to latest (per upgrade policy)";
const UPGRADE_INSIGHT_SOURCE = "environment-management: upgrade verb";

/**
 * Generate a version-change DAG node for a project's dependency upgrade and insert it
 * via the EXISTING spec-creation path. Reads the project's declared `upgrade` command +
 * upgrade policy; refuses (no node) when the project is pinned or declares no command;
 * otherwise authors a spec whose run executes `just upgrade`, regenerates the lockfile,
 * and commits — then routes it through `acceptProposals` so it runs the full gate. NEVER
 * mutates dependencies/lockfiles itself and NEVER merges without the gate.
 */
export async function generateUpgradeSpec(
  deps: GenerateUpgradeSpecDeps,
  input: GenerateUpgradeSpecInput,
): Promise<GenerateUpgradeSpecResult> {
  const config = migrateProjectConfig(await ProjectStore.getConfig(deps.pool, input.projectId, systemActor));
  const policy = config.upgradePolicy;

  // §4.5 motivation 1/4 — a deliberately-pinned project is first-class; Tanren generates
  // no forced-upgrade work for it (never overrides a pin).
  if (!policy.keepCurrent) {
    return { kind: "refused", reason: "policy_pinned" };
  }

  const upgradeCommand = config.lifecycle?.upgrade?.trim() ?? "";
  if (upgradeCommand === "") {
    return { kind: "refused", reason: "no_upgrade_command" };
  }

  const proposal = buildUpgradeProposal(policy);
  const { accepted } = await acceptProposals(
    { pool: deps.pool },
    {
      projectId: input.projectId,
      insight: upgradeInsight(config.lifecycle),
      proposals: [proposal],
      // A maintenance upgrade slots onto the backlog (it is not a feature interrupt); the
      // DagWalker orders by priority. The gate is what makes it safe regardless of slot.
      placementKind: "slot_after",
      placementLabel: "generated upgrade node (environment-management §4.5)",
      actor: { ...input.actor, orgId: input.orgId },
    },
  );
  const specId = accepted[0]?.spec.specId ?? "";
  return { kind: "generated", specId };
}

// Author the upgrade spec — the unit of work whose run executes the project's `upgrade`
// verb, regenerates the lockfile, and commits. The acceptance criteria pin the
// never-break-main contract: the gate runs the new toolchain through tiers + build and
// the change only merges green (a breaking bump is gate-rejected). Stack-AGNOSTIC: the
// description names `just upgrade`, not any dependency manager (the command lives in the
// project's justfile). The supply-chain COOLDOWN is carried as INTENT for the writer to
// honor via the project's own tooling — Tanren never parses package metadata itself.
function buildUpgradeProposal(policy: ProjectUpgradePolicy): ProposedSpec {
  const cooldown =
    policy.minimumReleaseAgeDays > 0
      ? `Respect the supply-chain cooldown: do not adopt any version published in the last ${policy.minimumReleaseAgeDays} day(s) (dodges a freshly-compromised release) — honor this through the project's own upgrade tooling.`
      : "No supply-chain cooldown is configured (minimumReleaseAgeDays = 0).";
  return {
    proposalId: "upgrade_deps",
    title: UPGRADE_SPEC_TITLE,
    description: [
      "Bump this project's dependencies to the latest versions allowed by its upgrade policy,",
      "then regenerate the lockfile and commit the result.",
      "",
      "Run the project's declared upgrade verb (`just upgrade`) to perform the bump + lockfile",
      "regeneration — Tanren names no dependency manager; the actual command lives in the",
      "project's justfile. Do NOT hand-edit dependency manifests or lockfiles by another route.",
      "",
      cooldown,
      "",
      "PURPOSEFUL PINS ARE PRESERVED: do not override a version the project deliberately pinned;",
      "propose only within the project's declared constraints.",
      "",
      "This change runs through the full gate like any other DAG node (environment-management.md",
      "§4.5): it merges only if the project still builds + passes its tiers under the new",
      "versions. A breaking bump is gate-rejected loudly — it must never break main.",
    ].join("\n"),
    acceptanceCriteria: [
      "`just upgrade` runs successfully and bumps dependencies to latest per the upgrade policy.",
      "The lockfile is regenerated and committed.",
      "The full gate (tiers + build) passes under the new versions; a breaking change is rejected, not forced.",
      "No deliberately-pinned version is silently overridden.",
    ],
    dependsOn: [],
    priority: "tbd",
    estLabel: "",
  };
}

// Build the discovery insight the accept hand-off stamps as provenance, so a generated
// upgrade node is observably "discovered by the upgrade verb" (the same provenance shape
// every spec-creation path records).
function upgradeInsight(lifecycle: ProjectLifecycle | undefined): DiscoveryInsight {
  const stack = lifecycle?.stack ?? "the project stack";
  return {
    variant: "bug",
    source: UPGRADE_INSIGHT_SOURCE,
    sourceLabel: "upgrade verb",
    who: "Tanren environment management",
    when: "on upgrade trigger",
    glyph: "↑",
    body: `Generated dependency-upgrade node for ${stack}: bump deps to latest per the project's upgrade policy and run it through the never-break-main gate.`,
  };
}
