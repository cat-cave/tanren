// ds-5 — the WITHIN-ORG design REUSE HTTP surface: the reusable-systems catalog
// (Studio), the per-project reuse BINDING (read + admin PUT), the render-verdict
// EVIDENCE LAB, and the artifact EXPORT index + real byte download. Org-scoped,
// versioned under `/v1`; every read/write runs through `runWithOrgScope` in the
// store so RLS confines it to the caller's org — a cross-org request sees ZERO
// rows (→ 404 / empty). Authorization mirrors the rv-22 read surface:
// `actorCanAccessOrg` on the path org, `assertProjectAccess` binds the project,
// and the reuse-binding WRITE additionally requires org-admin.
//
// Mounted at "/v1/orgs":
//   GET  /:orgId/design-systems
//   GET  /:orgId/projects/:projectId/design-binding
//   PUT  /:orgId/projects/:projectId/design-binding      (org-admin)
//   GET  /:orgId/projects/:projectId/design-evidence
//   GET  /:orgId/design-artifacts/:artifactId/exports
//   GET  /:orgId/design-artifacts/:artifactId/exports/download?path=...

import { runWithOrgScope } from "@tanren/db";
import { Hono, type Context } from "hono";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import {
  ArtifactDigestMismatchError,
  ArtifactNotFoundError,
  DEFAULT_DESIGN_ARTIFACT_ROOT,
  FilesystemArtifactStore,
  type ArtifactStore,
} from "../../engine/design/system/artifactStore.js";
import { DesignBindingTargetError, DesignStudioStore } from "../../engine/design/system/designStudioStore.js";
import { readLatestDesignRenderVerdictForProject } from "../../engine/design/render/designRenderVerdictStore.js";
import type { DesignRenderVerdictRow } from "../../engine/design/render/designRenderVerdictStore.js";
import {
  gatherDesignDeliveryEvidence,
  resolveLatestProjectDelivery,
} from "../../engine/design/queue/designDeliveryProofReads.js";
import { buildDesignDeliveryProof } from "../../engine/design/queue/designDeliveryProofGates.js";
import { DESIGN_DELIVERY_PROOF_SCHEMA_VERSION } from "../../engine/design/queue/designDeliveryProof.js";
import { assertProjectAccess, ToolAccessDeniedError } from "../../engine/forge/tools/authz.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg, actorIsOrgAdmin } from "../orgs/access.js";
import { DS_STUDIO_SURFACE_VERSION, PutDesignBindingBodySchema } from "./contract.js";

export type DesignStudioReadStore = Pick<
  DesignStudioStore,
  "listCatalog" | "getBinding" | "putBinding" | "listExportFiles" | "getExportFile"
>;

export interface DesignStudioRoutesOptions {
  readonly pool: pg.Pool;
  /** The CAS byte store the export download streams from. Defaults to the shared
   * local design-artifact root the greenfield composer writes to. */
  readonly artifactStore?: ArtifactStore;
  readonly store?: DesignStudioReadStore;
}

type RouteContext = Context<ActorContextEnv>;

function requireActor(c: RouteContext): ActorContext {
  if (c.var.actor === undefined) throw new Error("actor missing on context");
  return c.var.actor;
}

function requireParam(c: RouteContext, name: string): string {
  const value = c.req.param(name);
  if (value === undefined || value === "") throw new Error(`route parameter ${name} missing`);
  return value;
}

function isResponse(value: unknown): value is Response {
  return value instanceof Response;
}

function authorizeOrg(c: RouteContext): { orgId: string } | Response {
  const actor = requireActor(c);
  const orgId = requireParam(c, "orgId");
  if (!actorCanAccessOrg(actor, orgId)) return c.json({ error: "org_access_denied" }, 403);
  return { orgId };
}

async function authorizeProject(
  c: RouteContext,
  pool: pg.Pool,
): Promise<{ orgId: string; projectId: string } | Response> {
  const actor = requireActor(c);
  const orgId = requireParam(c, "orgId");
  const projectId = requireParam(c, "projectId");
  if (!actorCanAccessOrg(actor, orgId)) return c.json({ error: "org_access_denied" }, 403);
  try {
    const project = await runWithOrgScope(pool, orgId, (client) => assertProjectAccess(client, projectId, actor));
    if (project.orgId !== orgId) return c.json({ error: "project_access_denied" }, 403);
  } catch (error) {
    if (error instanceof ToolAccessDeniedError) return c.json({ error: "project_access_denied" }, 403);
    throw error;
  }
  return { orgId, projectId };
}

function verdictToWire(row: DesignRenderVerdictRow) {
  return {
    outcome: row.outcome,
    accessibilityStandard: row.accessibilityStandard,
    designContractVersion: row.designContractVersion,
    releaseId: row.releaseId,
    contractDigest: row.contractDigest,
    failingScenarioKey: row.failingScenarioKey,
    failingRuleIds: [...row.failingRuleIds],
    checkpointCount: row.checkpointCount,
    checkpoints: row.checkpoints.map((checkpoint) => ({
      checkpointId: checkpoint.checkpointId,
      verdict: checkpoint.verdict,
      failingRuleIds: [...checkpoint.failingRuleIds],
      ...(checkpoint.diffRatio === undefined ? {} : { diffRatio: checkpoint.diffRatio }),
      ...(checkpoint.screenshotDigest === undefined ? {} : { screenshotDigest: checkpoint.screenshotDigest }),
    })),
  };
}

export function createDesignStudioRoutes(options: DesignStudioRoutesOptions) {
  const app = new Hono<ActorContextEnv>();
  const store = options.store ?? new DesignStudioStore(options.pool);
  const artifactStore = options.artifactStore ?? new FilesystemArtifactStore(DEFAULT_DESIGN_ARTIFACT_ROOT);

  // Studio / reuse catalog: every reusable design-system family in the org.
  app.get("/:orgId/design-systems", async (c) => {
    const scope = authorizeOrg(c);
    if (isResponse(scope)) return scope;
    const systems = await store.listCatalog(scope.orgId);
    return c.json({ version: DS_STUDIO_SURFACE_VERSION, orgId: scope.orgId, systems });
  });

  // Read a project's current within-org reuse binding.
  app.get("/:orgId/projects/:projectId/design-binding", async (c) => {
    const scope = await authorizeProject(c, options.pool);
    if (isResponse(scope)) return scope;
    const binding = await store.getBinding(scope.orgId, scope.projectId);
    return c.json({ version: DS_STUDIO_SURFACE_VERSION, orgId: scope.orgId, projectId: scope.projectId, binding });
  });

  // Bind a project to reuse another same-org design system (org-admin write).
  app.put("/:orgId/projects/:projectId/design-binding", async (c) => {
    const scope = await authorizeProject(c, options.pool);
    if (isResponse(scope)) return scope;
    const actor = requireActor(c);
    if (!actorIsOrgAdmin(actor, scope.orgId)) return c.json({ error: "org_admin_required" }, 403);
    const parsed = PutDesignBindingBodySchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) return c.json({ error: "invalid_binding", issues: parsed.error.issues }, 400);
    try {
      const binding = await store.putBinding({
        orgId: scope.orgId,
        projectId: scope.projectId,
        designSystemId: parsed.data.designSystemId,
        pinMode: parsed.data.pinMode,
        pinnedReleaseId: parsed.data.pinnedReleaseId ?? null,
        channel: parsed.data.channel ?? null,
        boundBy: actor.userId,
      });
      return c.json({ version: DS_STUDIO_SURFACE_VERSION, orgId: scope.orgId, projectId: scope.projectId, binding });
    } catch (error) {
      if (error instanceof DesignBindingTargetError) {
        return c.json({ error: "binding_target_invalid", message: error.detail }, 409);
      }
      throw error;
    }
  });

  // Evidence lab: the latest run-level design-render verdict for the project.
  app.get("/:orgId/projects/:projectId/design-evidence", async (c) => {
    const scope = await authorizeProject(c, options.pool);
    if (isResponse(scope)) return scope;
    const row = await readLatestDesignRenderVerdictForProject(options.pool, scope.orgId, scope.projectId);
    return c.json({
      version: DS_STUDIO_SURFACE_VERSION,
      orgId: scope.orgId,
      projectId: scope.projectId,
      verdict: row === undefined ? null : verdictToWire(row),
    });
  });

  // ds-6 delivery trace: the VERIFIED-JOIN DesignDeliveryProofV1 (A4 ≡ demo) for the
  // project's latest production delivery. A read-only projection — NEVER a run-command
  // control. Fail-closed: no live production delivery yields a `blocked_no_live_release`
  // trace, never a fabricated A4 ≡ demo. Every field served is non-secret (no live URL,
  // no provider body, screenshots referenced by CAS digest only).
  app.get("/:orgId/projects/:projectId/design-delivery-proof", async (c) => {
    const scope = await authorizeProject(c, options.pool);
    if (isResponse(scope)) return scope;
    const delivery = await resolveLatestProjectDelivery(options.pool, scope.orgId, scope.projectId);
    if (delivery === undefined) {
      return c.json({
        version: DS_STUDIO_SURFACE_VERSION,
        orgId: scope.orgId,
        projectId: scope.projectId,
        proof: {
          version: 1 as const,
          schemaVersion: DESIGN_DELIVERY_PROOF_SCHEMA_VERSION,
          orgId: scope.orgId,
          projectId: scope.projectId,
          runId: "",
          integrationNodeId: "",
          equivalence: "blocked_no_live_release" as const,
          preMerge: null,
          production: null,
          boundKey: null,
        },
      });
    }
    const evidence = await gatherDesignDeliveryEvidence(options.pool, delivery.coords, delivery.integrationNodeId);
    const proof = buildDesignDeliveryProof(evidence);
    return c.json({ version: DS_STUDIO_SURFACE_VERSION, orgId: scope.orgId, projectId: scope.projectId, proof });
  });

  // Export index: the downloadable projections persisted in an artifact bundle.
  app.get("/:orgId/design-artifacts/:artifactId/exports", async (c) => {
    const scope = authorizeOrg(c);
    if (isResponse(scope)) return scope;
    const artifactId = requireParam(c, "artifactId");
    const files = await store.listExportFiles(scope.orgId, artifactId);
    const base = `/v1/orgs/${scope.orgId}/design-artifacts/${artifactId}/exports/download`;
    return c.json({
      version: DS_STUDIO_SURFACE_VERSION,
      orgId: scope.orgId,
      artifactId,
      files: files.map((file) => ({ ...file, href: `${base}?path=${encodeURIComponent(file.path)}` })),
    });
  });

  // Export download: stream the REAL persisted bytes (verified by digest). If the
  // CAS byte is absent/mismatched, fail LOUD (503) — never a fabricated file.
  app.get("/:orgId/design-artifacts/:artifactId/exports/download", async (c) => {
    const scope = authorizeOrg(c);
    if (isResponse(scope)) return scope;
    const artifactId = requireParam(c, "artifactId");
    const path = c.req.query("path");
    if (path === undefined || path === "") return c.json({ error: "missing_path" }, 400);
    const file = await store.getExportFile(scope.orgId, artifactId, path);
    if (file === null) return c.json({ error: "export_not_found" }, 404);
    let bytes: Uint8Array;
    try {
      bytes = await artifactStore.get(file.digest);
    } catch (error) {
      if (error instanceof ArtifactNotFoundError || error instanceof ArtifactDigestMismatchError) {
        return c.json({ error: "artifact_bytes_unavailable", message: (error as Error).message }, 503);
      }
      throw error;
    }
    // Copy into a fresh, exactly-sized ArrayBuffer (a BodyInit the runtime streams).
    const body = new Uint8Array(bytes).buffer;
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": file.mediaType,
        "content-disposition": `attachment; filename="${path.split("/").pop() ?? "export"}"`,
        "x-artifact-digest": file.digest,
      },
    });
  });

  return app;
}
