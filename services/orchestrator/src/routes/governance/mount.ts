import type { Hono } from "hono";
import { buildForgeGovernanceFragmentAuthorerFactory } from "../../engine/forge/governanceFragmentAuthorerFactory.js";
import type { ForgeAnswererInfra } from "../../engine/forge/providerFactory.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { createGovernanceRoutes } from "./index.js";

/** Mount gv-10's real authoring producer without inflating the feature-route table. */
export function mountGovernanceRoutes(app: Hono<ActorContextEnv>, infra: ForgeAnswererInfra): void {
  app.route(
    "/orgs",
    createGovernanceRoutes({
      pool: infra.pool,
      governanceFragmentAuthorer: buildForgeGovernanceFragmentAuthorerFactory(infra),
    }),
  );
}
