// Tanren-native templating (wave 1) — the template REGISTRY operator routes.
//
//   GET  /:orgId/templates                 → { templates } (own + official tier)
//   GET  /:orgId/templates?runtime=…&…     → capability-filtered list (selection)
//   GET  /:orgId/templates/:templateId     → one template (own or official)
//   POST /:orgId/templates                  register a template (parse manifest →
//                                            persist; draft unless validated)
//   PATCH /:orgId/templates/:templateId/status  transition the lifecycle tier
//
// Enough for an operator to inspect/register templates + for later waves (the
// validation harness flips status, selection queries by capability). Mounted on
// the shared `/orgs` base; the handed-in `pool` is the request-org-scoping pool
// (mountFeatureRoutes' `scopedPool`), so under RLS every read/write runs inside
// the request's `app.current_org_id` scope — a list returns the org's own
// templates PLUS the cross-org `official` catalogue (the templates RLS read-side
// exception), and a write can only land under the addressed org. The route also
// `actorCanAccessOrg`-gates the addressed org at the app layer (defense in depth).
//
// REGISTRATION takes RAW `.tanren/template.yml` TEXT and parses it through the
// authoritative `parseTemplateManifest` (the same fail-loud parser the manifest
// rides through inside a template repo) — a malformed manifest is a LOUD 400, not
// a half-registered template. The operator API mirrors the real flow: a template
// is the manifest text + the conforming-repo ref, exactly as a creation run would
// register it.
//
// No event is emitted here: the registry lifecycle events (`template.registered`
// / `template.status_changed`) are wired into the vocabulary for the creation
// meta-DAG (a later wave) to emit WITH a real run/project context — the events
// table derives org_id from a project, which a project-less registry CRUD has no
// clean sink for. This route is the durable WRITE/READ surface only.

import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import { TemplateStore, type TemplateCapabilityQuery, type TemplateStatus } from "../../engine/repositories/index.js";
import {
  TemplateManifestValidationError,
  TemplateManifestYamlParseError,
  parseTemplateManifest,
} from "../../engine/templates/manifest.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg, actorIsOrgAdmin } from "../orgs/access.js";

export interface TemplateRoutesOptions {
  // The request-org-scoping pool (mountFeatureRoutes' `scopedPool`): each `.query`
  // runs inside the request's org scope, so RLS bounds every read/write.
  pool: pg.Pool;
}

const TemplateStatusBody = z.enum(["draft", "validated", "degraded", "official"]);

const RegisterBody = z
  .object({
    // The conforming template repo ref (owner/repo or clone url).
    repoRef: z.string().min(1).max(512),
    // The RAW `.tanren/template.yml` text — parsed + validated here, fail-loud.
    manifestYaml: z.string().min(1),
    // The initial lifecycle tier; defaults to `draft` (unvalidated).
    status: TemplateStatusBody.default("draft"),
  })
  .strict();

const StatusBody = z.object({ status: TemplateStatusBody }).strict();

// The capability query string params selection filters on (templating-system.md
// §3) — runtime/pkg-mgr/framework/deploy-target + channel + status.
const CapabilityQuery = z
  .object({
    runtime: z.string().min(1).optional(),
    packageManager: z.string().min(1).optional(),
    framework: z.string().min(1).optional(),
    deployTarget: z.string().min(1).optional(),
    channel: z.enum(["lts", "nightly"]).optional(),
    status: TemplateStatusBody.optional(),
  })
  .strict();

export function createTemplateRoutes(options: TemplateRoutesOptions) {
  const app = new Hono<ActorContextEnv>();
  const operatorActor = { kind: "operator" as const };

  app.get("/:orgId/templates", async (c) => {
    const orgId = c.req.param("orgId");
    if (!guard(c, orgId)) return c.json({ error: "org_access_denied" }, 403);
    const parsed = CapabilityQuery.safeParse(queryRecord(c.req.query()));
    if (!parsed.success) return c.json({ error: "invalid_capability_query", issues: parsed.error.issues }, 400);
    const query = parsed.data;
    const hasFilter = Object.values(query).some((v) => v !== undefined);
    if (!hasFilter) {
      const templates = await TemplateStore.list(options.pool, operatorActor);
      return c.json({ templates }, 200);
    }
    const capabilityQuery: TemplateCapabilityQuery = {
      ...(query.runtime === undefined ? {} : { runtime: query.runtime }),
      ...(query.packageManager === undefined ? {} : { packageManager: query.packageManager }),
      ...(query.framework === undefined ? {} : { framework: query.framework }),
      ...(query.deployTarget === undefined ? {} : { deployTarget: query.deployTarget }),
      ...(query.channel === undefined ? {} : { channel: query.channel }),
      ...(query.status === undefined ? {} : { statuses: [query.status] }),
    };
    const templates = await TemplateStore.listByCapabilities(options.pool, capabilityQuery, operatorActor);
    return c.json({ templates }, 200);
  });

  app.get("/:orgId/templates/:templateId", async (c) => {
    const orgId = c.req.param("orgId");
    if (!guard(c, orgId)) return c.json({ error: "org_access_denied" }, 403);
    const template = await TemplateStore.get(options.pool, c.req.param("templateId"), operatorActor);
    if (template === undefined) return c.json({ error: "template_not_found" }, 404);
    return c.json({ template }, 200);
  });

  app.post("/:orgId/templates", async (c) => {
    const orgId = c.req.param("orgId");
    if (!writeGuard(c, orgId)) return c.json({ error: "org_access_denied" }, 403);
    const parsed = RegisterBody.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) return c.json({ error: "invalid_template", issues: parsed.error.issues }, 400);
    let manifest;
    try {
      manifest = parseTemplateManifest(parsed.data.manifestYaml);
    } catch (error) {
      if (error instanceof TemplateManifestValidationError || error instanceof TemplateManifestYamlParseError) {
        return c.json({ error: "invalid_manifest", message: error.message }, 400);
      }
      throw error;
    }
    const template = await TemplateStore.create(
      options.pool,
      { orgId, repoRef: parsed.data.repoRef, manifest, status: parsed.data.status },
      operatorActor,
    );
    return c.json({ template }, 201);
  });

  app.patch("/:orgId/templates/:templateId/status", async (c) => {
    const orgId = c.req.param("orgId");
    if (!writeGuard(c, orgId)) return c.json({ error: "org_access_denied" }, 403);
    const parsed = StatusBody.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) return c.json({ error: "invalid_status", issues: parsed.error.issues }, 400);
    const status: TemplateStatus = parsed.data.status;
    const updated = await TemplateStore.updateStatus(options.pool, c.req.param("templateId"), status, operatorActor);
    if (updated === undefined) return c.json({ error: "template_not_found" }, 404);
    return c.json({ template: updated }, 200);
  });

  return app;
}

// Hono's `c.req.query()` returns a flat record already; passed through a guard so
// an unexpected array value (repeated param) is dropped to its first occurrence.
function queryRecord(q: Record<string, string>): Record<string, string> {
  return q;
}

function guard(c: { var: { actor?: ActorContext } }, orgId: string): boolean {
  return c.var.actor !== undefined && actorCanAccessOrg(c.var.actor, orgId);
}

function writeGuard(c: { var: { actor?: ActorContext } }, orgId: string): boolean {
  return c.var.actor !== undefined && actorIsOrgAdmin(c.var.actor, orgId);
}
