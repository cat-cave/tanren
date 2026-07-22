// Deploy-intent resolution for deploy-on-merge — the THREE-WAY distinction that
// replaces the old "undefined ⇒ silently skip" no-op (pre-hardening Fix-C):
//   • CONFIGURED — the project config carries a complete (provider + appId) deploy
//     target ⇒ the deploy fires.
//   • NONE — the project configures no deploy AND its org links no deploy-capable
//     integration ⇒ a LEGITIMATE clean no-op (most projects have no deploy target);
//     the caller LOGS it so a run that expects a live URL can tell this apart from a
//     silent skip.
//   • INCOMPLETE — a deploy IS expected (the org links a deploy-capable integration)
//     but the config does not resolve a complete target ⇒ the caller fails LOUD
//     (fail-closed), never a silent skip of a required deploy.
//
// Pure (no DB): the resolver takes the already-read project config + a
// `deployIntent` boolean the caller probes from active control grants, so the
// distinction is unit-testable without a pool. The deploy-intent predicate over a
// grant list lives here too (the caller supplies the grants).

import { migrateProjectConfig } from "../config/index.js";
import type { ProjectDeployTarget } from "./deployOnMergeShared.js";

/** The canonical capability id a deploy-capable integration grant advertises. */
export const DEPLOY_CAPABILITY = "deploy";

/** The provider kinds that ARE deploy providers (a grant under one signals deploy intent). */
export const DEPLOY_PROVIDER_KINDS: ReadonlySet<string> = new Set(["deploy.vercel", "deploy.flyio"]);

/** The resolution of a project's deploy intent on merge. */
export type DeployTargetResolution =
  | { kind: "configured"; target: ProjectDeployTarget }
  | { kind: "none" }
  | { kind: "incomplete"; orgId: string; reason: string };

/** The minimal grant shape the deploy-intent predicate reads. */
export interface DeployIntentGrant {
  providerKind: string;
  capabilities: string[];
}

/**
 * Whether a grant list signals a deploy is EXPECTED: any grant that advertises the
 * `deploy` capability OR is itself a deploy provider kind. Used to distinguish a
 * legitimate "no deploy configured" no-op from an "incomplete deploy config when a
 * deploy was expected" loud failure.
 */
export function grantsSignalDeployIntent(grants: readonly DeployIntentGrant[]): boolean {
  return grants.some(
    (grant) => grant.capabilities.includes(DEPLOY_CAPABILITY) || DEPLOY_PROVIDER_KINDS.has(grant.providerKind),
  );
}

/**
 * Resolve a project's deploy intent from its (already-read) config + whether a
 * deploy is expected (the caller's control-grant probe). `orgId` is the
 * project's resolved org (null ⇒ no tenant grant can exist ⇒ a legitimate no-op).
 */
export function resolveDeployTarget(input: {
  orgId: string | null;
  config: Record<string, unknown>;
  deployIntent: boolean;
}): DeployTargetResolution {
  if (input.orgId === null) return { kind: "none" };
  const provider = input.config["deployProvider"];
  const appId = input.config["deployAppId"];
  if (typeof provider === "string" && typeof appId === "string") {
    // The governance policy version IS the project config version; parse it through
    // the strict migrator (a missing/unknown version is a LOUD error, never a silent
    // default) so the deploy audit record carries the real policy.
    const policyVersion = migrateProjectConfig(input.config).version;
    return { kind: "configured", target: { provider, appId, orgId: input.orgId, policyVersion } };
  }
  // Config is incomplete. No deploy expected ⇒ legitimate no-op; otherwise LOUD.
  if (!input.deployIntent) return { kind: "none" };
  const missingFields: string[] = [];
  if (typeof provider !== "string") missingFields.push("deployProvider");
  if (typeof appId !== "string") missingFields.push("deployAppId");
  return {
    kind: "incomplete",
    orgId: input.orgId,
    reason: `missing ${missingFields.join(" and ")} in project config`,
  };
}
