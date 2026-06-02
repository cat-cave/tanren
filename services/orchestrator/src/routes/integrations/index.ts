// P-INT-2: the capability-driven onboarding HTTP surface (orchestrator side).
//
//   POST /:orgId/projects/:projectId/integrations/provision
//     Body: { capability, providerKind?, mode, chosenResourceId?, stack?, name? }.
//     Requests a CAPABILITY ("enable error tracking", "notify on Slack",
//     "deploy") for the project — NOT a leaf secret. The engine resolves the org
//     grant from `org_integrations`, builds the provisioner with PRODUCTION deps,
//     applies confirm-with-smart-default (discover → create/bind), persists the
//     artifact over the existing surfaces, emits `integration.provisioned`, and
//     returns what was created/bound BY REFERENCE (never a secret value).
//
//     - Org hasn't linked the provider → 200 with `{ status: "not_linked", ... }`
//       carrying a link-first message + a deep-link affordance (a structured
//       response the dashboard renders, NOT a crash / 5xx).
//     - Provisioned/bound → 201 with the refs (secret REF NAMES, surface ids,
//       projectConfig keys, deployRef) — no secret material.
//
//   GET /:orgId/projects/:projectId/integrations/discover
//     Query: { capability, providerKind? }. Lists the org's existing resources of
//     this kind so the dashboard can render the smart-default picker before any
//     provider write. Returns `not_linked` (link-first) when no grant exists.
//
// The route shape is intentionally clean for the dashboard capability-toggle UI
// (a follow-up) to call: a single POST per enabled capability. Production wires
// the configured SecretStore + the real provisioner registry; tests drive the
// engine directly with a fake provisioner.

import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import type { SecretStore } from "../../engine/contracts/secretStore.js";
import { PgEventStore } from "../../engine/eventStore.js";
import {
  buildIntegrationProvisioner,
  type IntegrationProvisioner,
} from "../../engine/contracts/integrationProvisioner.js";
import {
  productionProvisionerDeps,
  provisionCapability,
  resolveProviderKind,
} from "../../engine/integrations/provisioningEngine.js";
import { OrgIntegrationsStore } from "../../engine/repositories/orgIntegrations.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/index.js";

export interface IntegrationRoutesOptions {
  pool: pg.Pool;
  /** The configured SecretStore the production provisioner deps run over. */
  secrets: SecretStore;
}

const ProvisionMode = z.enum(["greenfield", "brownfield"]);

const ProvisionBody = z
  .object({
    capability: z.string().min(1).max(64),
    providerKind: z.string().min(1).max(64).optional(),
    mode: ProvisionMode,
    chosenResourceId: z.string().min(1).max(200).optional(),
    stack: z.string().min(1).max(64).optional(),
    name: z.string().min(1).max(200).optional(),
  })
  .strict();

export function createIntegrationRoutes(options: IntegrationRoutesOptions) {
  const app = new Hono<ActorContextEnv>();
  const events = new PgEventStore(options.pool);

  app.post("/:orgId/projects/:projectId/integrations/provision", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    const projectId = c.req.param("projectId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const parsed = ProvisionBody.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_provision", issues: parsed.error.issues }, 400);
    }
    // A capability/provider pairing that cannot resolve is a 400 (programmer
    // error), distinct from the expected not-linked case (a 200 link-first).
    try {
      resolveProviderKind(parsed.data.capability, parsed.data.providerKind);
    } catch (error) {
      return c.json({ error: "unresolvable_capability", message: messageOf(error) }, 400);
    }
    try {
      const outcome = await provisionCapability(
        {
          client: options.pool,
          secrets: options.secrets,
          events,
          actor: { kind: "operator", id: actor.userId },
        },
        { projectId, orgId, ...parsed.data },
      );
      // not_linked is a successful, structured response (not an error path).
      return c.json(outcome, outcome.status === "not_linked" ? 200 : 201);
    } catch (error) {
      return c.json({ error: "provision_failed", message: messageOf(error) }, 500);
    }
  });

  app.get("/:orgId/projects/:projectId/integrations/discover", async (c) => {
    const actor = requireActor(c);
    const orgId = c.req.param("orgId");
    if (!actorCanAccessOrg(actor, orgId)) {
      return c.json({ error: "org_access_denied" }, 403);
    }
    const capability = c.req.query("capability") ?? "";
    const providerKindQuery = c.req.query("providerKind");
    let providerKind: string;
    try {
      providerKind = resolveProviderKind(capability, providerKindQuery);
    } catch (error) {
      return c.json({ error: "unresolvable_capability", message: messageOf(error) }, 400);
    }
    const grant = await OrgIntegrationsStore.getGrant(options.pool, orgId, providerKind, {
      kind: "operator",
      id: actor.userId,
    });
    if (grant === undefined) {
      return c.json(
        {
          status: "not_linked",
          capability,
          providerKind,
          message: `link ${providerKind} at the org level first.`,
          linkAffordance: { kind: "org_integration_link", providerKind, orgId },
        },
        200,
      );
    }
    try {
      const provisioner: IntegrationProvisioner = buildIntegrationProvisioner(
        providerKind,
        productionProvisionerDeps(options.secrets),
      );
      const discovered = await provisioner.discover(grant);
      return c.json({ status: "discovered", capability, providerKind, resources: discovered }, 200);
    } catch (error) {
      return c.json({ error: "discover_failed", message: messageOf(error) }, 500);
    }
  });

  return app;
}

function requireActor(c: { var: { actor?: ActorContext } }): ActorContext {
  if (c.var.actor === undefined) {
    throw new Error("actor missing on context");
  }
  return c.var.actor;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
