/**
 * rv-6 A2: resolves the deployed product's base URL from `release_instances`
 * (rv-5 preview/live deploy) for the api surface driver to probe. It reads the
 * project's release instances under org scope and returns the most recent one
 * carrying a non-empty URL. No deployed URL ⇒ `unresolved`, which the driver
 * fails closed to inconclusive_infrastructure — a run never probes a fabricated
 * or stale endpoint.
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
    // listForProject orders oldest→newest; the last probeable instance with a
    // non-empty URL is the freshest deploy for this project.
    let baseUrl: string | undefined;
    for (const instance of instances) {
      if (instance.url !== "" && PROBEABLE_STATES.has(instance.state)) baseUrl = instance.url;
    }
    if (baseUrl === undefined) {
      return { kind: "unresolved", reason: `no deployed release instance url for project ${input.projectId}` };
    }
    return { kind: "resolved", baseUrl };
  }
}
