// ds-7 — the adapter conformance route handlers, extracted from
// `reads.ts` to keep that file under the module-dependency cap. Returns the
// receipt + evidence for one target OR the full per-target panel.

import { type Context, type Hono } from "hono";
import type {
  DesignAdapterConformanceStore,
  DesignAdapterConformanceRunRow,
} from "../../engine/design/system/adapterConformanceStore.js";
import {
  DESIGN_ADAPTER_CONFORMANCE_TARGETS,
  type DesignAdapterConformanceTarget,
} from "../../engine/design/system/adapterConformanceReceipt.js";
import { DS_STUDIO_SURFACE_VERSION } from "./contract.js";
import type { ActorContextEnv } from "../../middleware/auth.js";

export function conformanceRunToWire(row: DesignAdapterConformanceRunRow) {
  return {
    id: row.id,
    target: row.target,
    adapterVersion: row.adapterVersion,
    artifactId: row.artifactId,
    releaseId: row.releaseId,
    artifactDigest: row.artifactDigest,
    receiptDigest: row.receiptDigest,
    outcome: row.outcome,
    notes: row.notes,
    createdAt: row.createdAt,
    requiredCapabilities: row.receipt?.requiredCapabilities ?? [],
    scenarioMatrixDigest: row.receipt?.scenarioMatrixDigest ?? "",
    resolvedCapabilities: row.receipt?.resolvedCapabilities ?? [],
    criticalProofs: row.receipt?.criticalProofs ?? [],
    positiveCases: row.receipt?.positiveCases ?? [],
    negativeControls: row.receipt?.negativeControls ?? [],
  };
}

/** Mount the ds-7 conformance routes on the given Hono app. */
export function mountDesignAdapterConformanceRoutes(
  app: Hono<ActorContextEnv>,
  options: {
    readonly conformanceStore: DesignAdapterConformanceStore;
    readonly authorizeProject: (
      c: Context<ActorContextEnv>,
    ) => Promise<{ readonly orgId: string; readonly projectId: string } | Response>;
    readonly requireParam: (c: Context<ActorContextEnv>, name: string) => string;
  },
): void {
  // GET one target's latest receipt.
  app.get("/:orgId/projects/:projectId/design-adapters/:target/conformance", async (c) => {
    const scope = await options.authorizeProject(c);
    if (scope instanceof Response) return scope;
    const targetParam = options.requireParam(c, "target");
    if (!DESIGN_ADAPTER_CONFORMANCE_TARGETS.includes(targetParam as DesignAdapterConformanceTarget)) {
      return c.json({ error: "unsupported_target", target: targetParam }, 400);
    }
    const target = targetParam as DesignAdapterConformanceTarget;
    const row = await options.conformanceStore.readLatest(scope.orgId, scope.projectId, target);
    if (row === undefined) return c.json({ error: "no_conformance_run", target }, 404);
    return c.json({
      version: DS_STUDIO_SURFACE_VERSION,
      orgId: scope.orgId,
      projectId: scope.projectId,
      target,
      run: conformanceRunToWire(row),
    });
  });

  // GET the project's full target-conformance panel.
  app.get("/:orgId/projects/:projectId/design-adapters", async (c) => {
    const scope = await options.authorizeProject(c);
    if (scope instanceof Response) return scope;
    const rows = await options.conformanceStore.listForProject(scope.orgId, scope.projectId);
    const byTarget = new Map<string, DesignAdapterConformanceRunRow>();
    for (const row of rows) {
      if (!byTarget.has(row.target)) byTarget.set(row.target, row);
    }
    const targets = DESIGN_ADAPTER_CONFORMANCE_TARGETS.map((target) => {
      const row = byTarget.get(target);
      return {
        target,
        requiredCapabilities: row?.receipt?.requiredCapabilities ?? [],
        adapterVersion: row?.adapterVersion ?? "",
        outcome: row?.outcome ?? "inconclusive_infrastructure",
        artifactId: row?.artifactId ?? "",
        receiptDigest: row?.receiptDigest ?? "",
        evidenceLinks:
          row === undefined
            ? []
            : [
                { rel: "artifact", href: `/v1/orgs/${scope.orgId}/design-artifacts/${row.artifactId}/exports` },
                {
                  rel: "run",
                  href: `/v1/orgs/${scope.orgId}/projects/${scope.projectId}/design-adapters/${row.target}/conformance`,
                },
              ],
      };
    });
    return c.json({
      version: DS_STUDIO_SURFACE_VERSION,
      orgId: scope.orgId,
      projectId: scope.projectId,
      targets,
    });
  });
}
