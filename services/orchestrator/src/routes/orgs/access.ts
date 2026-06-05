// Org access-authorization predicates, extracted from `routes/orgs/index.ts` so
// they can be imported WITHOUT pulling in the org route factory (and the modules
// it re-exports). This is the leaf both the org routes and the sibling settings
// routes (credentials, ai-provider) import for their actor checks — keeping the
// import graph acyclic (the re-export of `createAiProviderRoutes` from
// `orgs/index.ts` would otherwise form a cycle with a route that needed these
// predicates from `orgs/index.ts`). Every consumer imports the predicates
// directly from this leaf — `orgs/index.ts` does NOT re-export them.

import type { ActorContext } from "../../auth/schemas.js";

/** True when the actor may READ the addressed org (member, admin, or platform admin). */
export function actorCanAccessOrg(actor: ActorContext, orgId: string): boolean {
  if (actor.scopes.includes("platform:admin")) return true;
  if (actor.orgId !== orgId) return false;
  return actor.scopes.includes("org:member") || actor.scopes.includes("org:admin");
}

/** True when the actor may WRITE the addressed org (admin or platform admin). */
export function actorIsOrgAdmin(actor: ActorContext, orgId: string): boolean {
  if (actor.scopes.includes("platform:admin")) return true;
  if (actor.orgId !== orgId) return false;
  return actor.scopes.includes("org:admin");
}
