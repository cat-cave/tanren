/**
 * in-2: validate + catalog HTTP for IntegrationRequirementV1 documents.
 * Mounted under free parent `/orgs` via behaviors thin wire — NOT
 * routes/integrations/** (IN-1 / #856 lease).
 */

import type { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import { PgCasByteStore } from "../../engine/cas/pgCasByteStore.js";
import type { CasByteStore } from "../../engine/contracts/cas.js";
import {
  INTEGRATION_REQUIREMENT_MEDIA_TYPE,
  canonicalRequirementBytes,
  integrationContractCatalog,
  integrationRequirementDigest,
  parseIntegrationRequirement,
} from "../../engine/contracts/integrationRequirement.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/access.js";

const ValidateBodySchema = z
  .object({
    requirement: z.unknown(),
  })
  .strict();

export interface IntegrationContractRouteOptions {
  pool: pg.Pool;
  /** Injected for tests; production uses PgCasByteStore(pool). */
  casByteStore?: CasByteStore;
}

export function registerIntegrationContractRoutes(
  app: Hono<ActorContextEnv>,
  options: IntegrationContractRouteOptions,
): void {
  const cas = options.casByteStore ?? new PgCasByteStore(options.pool);

  app.get("/:orgId/integration-contracts/catalog", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    return c.json(integrationContractCatalog());
  });

  app.post("/:orgId/integration-contracts:validate", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json", message: "Request body must be JSON" }, 400);
    }

    const envelope = ValidateBodySchema.safeParse(raw);
    if (!envelope.success) {
      return c.json(
        {
          error: "invalid_request",
          issues: envelope.error.issues.map((i) => ({
            path: i.path.join(".") || "(root)",
            code: "schema",
            message: i.message,
          })),
        },
        400,
      );
    }

    const validated = parseIntegrationRequirement(envelope.data.requirement);
    if (!validated.ok) {
      return c.json(
        {
          ok: false as const,
          missionNodeId: "in-2" as const,
          errors: validated.issues,
        },
        422,
      );
    }

    const requirementDigest = integrationRequirementDigest(validated.requirement);
    const bytes = canonicalRequirementBytes(validated.requirement);
    const artifact = await cas.put({
      orgId,
      bytes,
      mediaType: INTEGRATION_REQUIREMENT_MEDIA_TYPE,
    });

    return c.json({
      ok: true as const,
      missionNodeId: "in-2" as const,
      orgId,
      requirementDigest,
      artifact: {
        digest: artifact.digest,
        byteSize: artifact.byteSize,
        mediaType: artifact.mediaType,
      },
      // Echo sanitized document identity only — never secrets (schema forbids them).
      capability: validated.requirement.capability,
      plane: validated.requirement.plane,
      direction: validated.requirement.direction,
      criticality: validated.requirement.criticality,
    });
  });
}

function requireActor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) {
    throw new Error("actor missing on context");
  }
  return c.var.actor;
}
