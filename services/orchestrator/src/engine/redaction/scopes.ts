import type { ActorContext, ActorScope } from "../../auth/schemas.js";
import type { Sensitivity } from "../events/sensitivity.js";

// The redaction layer uses the actor's scope set, not a strict ranking, to
// decide whether a payload field renders raw. The spec calls out that a
// scope at level N can view raw at sensitivity level N or below; we encode
// that as an explicit lookup so the policy is auditable in one place rather
// than as numeric arithmetic.
//
// Policy (matches the P2A-0009 entry verbatim):
//   public   -> any authenticated actor
//   redacted -> requires org:admin OR project:admin OR platform:admin
//   secret   -> requires platform:admin
//
// Note that org:admin/project:admin can view "redacted" but never "secret"
// — secret carries raw SSH stdout/stderr, provider tokens, etc., and per
// the brief is platform-administrative-only.

const SCOPES_VIEWING_REDACTED: ReadonlySet<ActorScope> = new Set<ActorScope>([
  "platform:admin",
  "org:admin",
  "project:admin"
]);

const SCOPES_VIEWING_SECRET: ReadonlySet<ActorScope> = new Set<ActorScope>([
  "platform:admin"
]);

export const sensitivityToRequiredScopes: Record<Sensitivity, ReadonlySet<ActorScope> | null> = {
  // public has no required scope — any authenticated actor sees raw.
  public: null,
  redacted: SCOPES_VIEWING_REDACTED,
  secret: SCOPES_VIEWING_SECRET
};

// AccessScopeOrder is exported so callers and tests can reason about the
// relative privilege of scopes without re-implementing the policy. Lower
// index = lower privilege. The redaction layer itself uses
// `sensitivityToRequiredScopes`; this ordering is documentation that future
// surfaces (UI hints, comparators) can consult.
export const AccessScopeOrder: readonly ActorScope[] = [
  "project:member",
  "org:member",
  "project:admin",
  "org:admin",
  "platform:admin"
];

// canViewRaw returns true when the actor holds at least one of the scopes
// required to view the given sensitivity. public is always viewable. An
// actor with no overlapping scopes never views above public.
export function canViewRaw(sensitivity: Sensitivity, actor: ActorContext): boolean {
  const required = sensitivityToRequiredScopes[sensitivity];
  if (required === null) {
    return true;
  }
  for (const scope of actor.scopes) {
    if (required.has(scope)) {
      return true;
    }
  }
  return false;
}

// hasElevatedScope identifies actors whose raw reads should be audited.
// Project-member reads are by definition only-public so we don't audit
// them; org:admin and platform:admin (the scopes that unlock redacted or
// secret) trigger an audit row.
export function hasElevatedScope(actor: ActorContext): boolean {
  for (const scope of actor.scopes) {
    if (scope === "platform:admin" || scope === "org:admin" || scope === "project:admin") {
      return true;
    }
  }
  return false;
}

// describeRequiredScope renders a short human-readable hint shown in the
// redaction marker so dashboards can explain why a field was hidden.
export function describeRequiredScope(sensitivity: Sensitivity): string {
  switch (sensitivity) {
    case "public":
      return "public";
    case "redacted":
      return "requires org:admin or project:admin";
    case "secret":
      return "requires platform:admin";
    default:
      return "unknown";
  }
}
