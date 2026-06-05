// SECURITY-BASELINE EGRESS / DEPLOY-TARGET ALLOWLIST SEAM
// (tanren-direction.md § "Security Baseline": "Runner egress policy,
// deployment-target allowlists, metadata-service blocking, and preview URL access
// control.").
//
// A managed Tanren runner is an untrusted-code execution surface; the security
// doctrine wants its network EGRESS and the set of DEPLOY TARGETS it may reach to be
// governed by a typed POLICY, not left open by default in managed mode. This module
// defines that policy as a SEAM (a slottable contract, like the allocator /
// secret-store seams) plus a DEFAULT-PERMISSIVE implementation — it is the place a
// managed-hosting build later slots a real restrictive policy WITHOUT touching the
// deploy/runner call sites. This is intentionally the SEAM + the default, not full
// enforcement: managed-hosting network specifics are deferred.
//
// SECURITY NOTE (a baseline rule): a policy DECISION is reasoned over non-secret
// inputs (a host, a provider, an app id) and produces a non-secret verdict + reason.
// No credential or secret value ever enters an egress decision or its audit record.

/** A network egress destination the runner is about to reach (host + optional port). */
export interface EgressDestination {
  /** The destination host (a DNS name or an IP literal). NON-SECRET. */
  host: string;
  /** The destination port, when known. */
  port?: number;
}

/** A deploy target the deploy path is about to operate (provider + app id). */
export interface DeployTargetRef {
  /** The deploy provider kind (e.g. `deploy.vercel` | `deploy.flyio`). NON-SECRET. */
  provider: string;
  /** The deployed app/project id. NON-SECRET. */
  appId: string;
}

/**
 * A policy verdict. `allowed` is the gate; `reason` is a NON-SECRET, fixed-vocabulary
 * explanation for the audit trail (why a destination/target was allowed or denied) so
 * a denial is never a silent drop — it is an auditable, reasoned decision.
 */
export interface EgressDecision {
  allowed: boolean;
  reason: string;
}

/**
 * The egress / deploy-target allowlist policy the deploy + runner paths consult
 * BEFORE reaching the network. A slottable seam: OSS / self-host slots the
 * default-permissive policy (no managed network controls); a managed-hosting build
 * slots a restrictive policy that enforces tenant-scoped allowlists, metadata-service
 * blocking, and preview access control. The call sites depend only on this interface.
 */
export interface EgressPolicy {
  /** Whether the runner may make a network connection to `destination`. */
  allowsEgress(destination: EgressDestination): EgressDecision;
  /** Whether the deploy path may operate `target` (the deploy-target allowlist). */
  allowsDeployTarget(target: DeployTargetRef): EgressDecision;
}

// The reason string the default policy stamps on every (permissive) decision. A
// fixed identifier so a downstream audit can tell a DEFAULT allow apart from a real
// allowlist-matched allow once a restrictive policy is slotted.
export const DEFAULT_PERMISSIVE_REASON = "default-permissive: no egress allowlist configured";

/**
 * The DEFAULT-PERMISSIVE egress policy: allows every destination + deploy target,
 * stamping the fixed default reason. This is the OSS / self-host posture (the runner's
 * isolation comes from the per-run ephemeral container, not a network allowlist) and
 * the safe no-op default in managed mode until a real restrictive policy is slotted.
 * It is NOT a stub: it is the intended, documented OPEN posture — an honest "no egress
 * controls configured", auditable via the reason on every decision.
 */
export class DefaultPermissiveEgressPolicy implements EgressPolicy {
  allowsEgress(_destination: EgressDestination): EgressDecision {
    return { allowed: true, reason: DEFAULT_PERMISSIVE_REASON };
  }

  allowsDeployTarget(_target: DeployTargetRef): EgressDecision {
    return { allowed: true, reason: DEFAULT_PERMISSIVE_REASON };
  }
}

/** The single default policy instance the call sites use until a managed policy is slotted. */
export const defaultEgressPolicy: EgressPolicy = new DefaultPermissiveEgressPolicy();
