// The operator-facing manual_external DEPLOY CONFIRMATION route (Codex H3 Surface 7
// finding #21). The `manual_external` DeployAdapter's `deploy()` writes a
// `pending_manual_confirmation` row + emits `deploy.pending_manual` (the wake); an
// operator responds to that wake via this endpoint, which flips the row to
// `confirmed` + emits `deploy.manual_confirmed`. Only then does the adapter's
// `verify()` run the URL smoke probe and produce `deploy.verified`. Without this
// route, `verify()` on a still-pending row FAILS LOUD — there is no rubber-stamp
// silent verified anymore.
//
// AUTH: org-admin (the confirmation is a governance action on the tenant's own
// project). CSRF is enforced by the shared auth middleware for session cookies on
// state-changing methods; a bearer API-token confirms without CSRF (the token
// scope already gates it).

import { runWithJobOrgId } from "@tanren/db";
import { Hono } from "hono";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import type { EventStore } from "../../engine/eventStore.js";
import { PgEventStore } from "../../engine/eventStore.js";
import { serviceAuditActor, auditActorFromRef } from "../../engine/events/schemas/audit.js";
import {
  MANUAL_EXTERNAL_PROVIDER_KIND,
  type ManualAttestationStore,
} from "../../engine/deploy/manualExternalDeployAdapter.js";
import { PgManualAttestationStore } from "../../engine/deploy/pgManualAttestationStore.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorIsOrgAdmin } from "../orgs/access.js";

/** The route factory's injected deps — pool + optional pre-built store/events (tests). */
export interface DeployRoutesOptions {
  pool: pg.Pool;
  /**
   * The DURABLE attestation store the confirmation writes into. Optional; when
   * omitted the factory constructs the production `PgManualAttestationStore` off
   * the pool. Injectable for tests that drive the route against the in-memory
   * store.
   */
  attestations?: ManualAttestationStore;
  /**
   * The event store the confirmation emits `deploy.manual_confirmed` into.
   * Optional; when omitted the factory constructs `PgEventStore(pool)`. Injectable
   * for tests that assert the emitted event without an events table.
   */
  events?: EventStore;
}

export function createDeployRoutes(options: DeployRoutesOptions) {
  const app = new Hono<ActorContextEnv>();
  const attestations = options.attestations ?? new PgManualAttestationStore(options.pool);
  const events = options.events ?? new PgEventStore(options.pool);

  // POST /orgs/:orgId/projects/:projectId/deploys/:deploymentId/confirm — confirm a
  // `manual_external` pending attestation. Org-admin (a governance action on the
  // tenant's project). Idempotent: a re-confirm returns the current row without
  // re-writing the audit trail and does NOT re-emit `deploy.manual_confirmed`
  // (the store's freshlyConfirmed discriminator is the emit gate).
  app.post("/:orgId/projects/:projectId/deploys/:deploymentId/confirm", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    const projectId = c.req.param("projectId");
    const deploymentId = c.req.param("deploymentId");
    if (!actorIsOrgAdmin(actor, orgId)) {
      return c.json({ error: "org_admin_required" }, 403);
    }
    const result = await attestations.confirm({
      deploymentId,
      orgId,
      confirmedBy: actor.userId,
    });
    if (result === undefined) {
      return c.json({ error: "manual_deploy_attestation_not_found" }, 404);
    }
    const { record, freshlyConfirmed } = result;
    if (record.orgId !== orgId || record.projectId !== projectId) {
      // The route's path uses a specific (org, project) key; the row's persisted
      // (org, project) MUST match or the confirmation is denied — a same-org row
      // routed via the wrong project path is never silently confirmed.
      return c.json({ error: "manual_deploy_attestation_not_found" }, 404);
    }
    // Emit ONLY on the fresh flip (no duplicate events on idempotent re-confirms).
    // The event carries the confirming operator as the `approvingActor` — the
    // audit-trail actor for the governance action; the initiating service is
    // Tanren's autonomous engine (the deploy was triggered by the run watcher).
    if (freshlyConfirmed) {
      await runWithJobOrgId(orgId, async () => {
        await events.append({
          orgId,
          projectId,
          eventType: "deploy.manual_confirmed",
          payload: {
            provider: MANUAL_EXTERNAL_PROVIDER_KIND,
            appId: record.appId,
            deploymentId: record.deploymentId,
            orgId,
            projectId,
            confirmedBy: actor.userId,
            initiatingActor: serviceAuditActor,
            approvingActor: auditActorFromRef({ kind: "operator", id: actor.userId }),
          },
        });
      });
    }
    return c.json({
      deploymentId: record.deploymentId,
      state: record.state,
      appId: record.appId,
      url: record.attestation.url,
      surfaceKind: record.attestation.surfaceKind,
      source: record.attestation.source,
      ...(record.confirmedAt === null ? {} : { confirmedAt: record.confirmedAt.toISOString() }),
      ...(record.confirmedBy === null ? {} : { confirmedBy: record.confirmedBy }),
      freshlyConfirmed,
    });
  });

  return app;
}

function requireActor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) {
    throw new Error("actor missing on context");
  }
  return c.var.actor;
}
