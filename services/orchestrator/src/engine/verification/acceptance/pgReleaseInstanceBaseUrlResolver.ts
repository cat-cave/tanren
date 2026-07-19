/**
 * rv-6 A2: resolves the deployed product's base URL from `release_instances`
 * (rv-5 preview/live deploy) for the api surface driver to probe.
 *
 * WRONG-TARGET FAIL-CLOSED (bh-10 class): it binds to THIS run's SPECIFIC
 * release — the release instance built for the run's `integrationNodeId` — never
 * a last-probeable-wins scan that could probe a stale/wrong deploy. If no
 * probeable release with a non-empty URL exists for this run's integration node,
 * it returns `unresolved`, which the driver fails closed to
 * inconclusive_infrastructure rather than probing the wrong endpoint.
 */

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { ReleaseInstancesStore } from "../../repositories/releaseInstances.js";
import type { AcceptanceDriveInput } from "./orchestrator.js";
import type { AcceptanceBaseUrlResolver } from "./httpDriver.js";

// A live/preview instance is the freshest deploy to verify; superseded / torn
// down / rolled back / failed instances are never probed.
const PROBEABLE_STATES = new Set(["built", "preview", "promoting", "live"]);

export class PgReleaseInstanceBaseUrlResolver implements AcceptanceBaseUrlResolver {
  public constructor(private readonly pool: pg.Pool) {}

  public async resolve(
    input: AcceptanceDriveInput,
  ): Promise<{ kind: "resolved"; baseUrl: string } | { kind: "unresolved"; reason: string }> {
    const instances = await runWithOrgScope(this.pool, input.orgId, (client) =>
      ReleaseInstancesStore.listForProject(client, input.orgId, input.projectId),
    );
    // Bind to the run's SPECIFIC release: only instances built for THIS run's
    // integration node are candidates. listForProject orders oldest→newest, so
    // the last matching probeable instance is the freshest deploy for this run.
    let baseUrl: string | undefined;
    for (const instance of instances) {
      if (
        instance.integrationNodeId === input.integrationNodeId &&
        instance.url !== "" &&
        PROBEABLE_STATES.has(instance.state)
      ) {
        baseUrl = instance.url;
      }
    }
    if (baseUrl === undefined) {
      return {
        kind: "unresolved",
        reason: `no deployed release instance url for integration node ${input.integrationNodeId}`,
      };
    }
    return { kind: "resolved", baseUrl };
  }
}
