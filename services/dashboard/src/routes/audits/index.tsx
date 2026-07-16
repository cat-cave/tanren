/**
 * scheduled-audits mount, registered through the append-only screen
 * registry. The job library + the window-fill bar + the forge-recommended
 * coverage panel + the new-audit composer, all server-rendered through the
 * shell. Reached from the sidebar (system · scheduled audits), the costs-page
 * "schedule overnight audits" CTA, and the greenfield arrival step.
 *
 * Routes registered:
 *   GET  /audits                       job library + window-fill + recommended
 *   POST /audits                       create a job (composer / recommended gap)
 *   POST /audits/:jobId/enable         enable
 *   POST /audits/:jobId/disable        pause
 *   POST /audits/:jobId/run            run the read-only pass now → inbox
 *
 * The audits client is its OWN api module (`api/auditsClient.ts`) per the screen-isolation
 * integration lesson; the window-fill bar reads the SAME subscription
 * heatmap the costs page uses (via the canonical org-costs read model) so it
 * ties to real idle-window data and invents nothing. No project→run→cost N+1.
 */

import type { Context, Hono } from "hono";
import { AuditsClient } from "../../api/auditsClient.js";
import type { AuditCadence, AuditKind, AuditsSnapshot } from "../../api/auditsTypes.js";
import { clientDepsFor } from "../../api/clientDeps.js";
import { OrchestratorClient } from "../../api/orchestrator.js";
import type { CostRecord } from "../../api/types.js";
import { loadShellContext, renderShell, type ShellDeps } from "../../app/mountShell.js";
import { buildHeatmap } from "../../components/costs/heatmap.js";
import { AuditsBody } from "../../components/audits/AuditsBody.js";
import { underfilledNames, windowFillColumns } from "../../components/audits/windowFill.js";

const EMPTY: AuditsSnapshot = { jobs: [], recommended: [] };
const VALID_KINDS = new Set<AuditKind>(["security", "deps", "a11y", "mutation", "perf", "license", "stale_specs"]);
const VALID_CADENCES = new Set<AuditCadence>(["nightly", "weekly", "monthly"]);

function readAuditsClient(c: Context, deps: ShellDeps): AuditsClient {
  return new AuditsClient({
    orchestratorUrl: deps.orchestratorUrl,
    cookieHeader: c.req.header("cookie"),
  });
}

async function writeAuditsClient(c: Context, deps: ShellDeps): Promise<AuditsClient> {
  return new AuditsClient(await clientDepsFor(c, deps));
}

/**
 * Subscription cost records for the window-fill heatmap — one bounded org-costs
 * read (the sole cost authority). Failures surface as unavailable, never as a
 * silent empty heatmap.
 */
async function gatherRecords(
  c: Context,
  deps: ShellDeps,
  orgId: string,
): Promise<{ records: CostRecord[]; unavailable: boolean }> {
  const client = new OrchestratorClient({
    orchestratorUrl: deps.orchestratorUrl,
    cookieHeader: c.req.header("cookie"),
  });
  const result = await client.getOrgCosts(orgId);
  if (result.kind !== "ok") {
    return { records: [], unavailable: true };
  }
  return { records: result.data.costs, unavailable: false };
}

function str(form: Record<string, unknown>, key: string): string {
  const value = form[key];
  return typeof value === "string" ? value : "";
}

export function mountAuditScreens(app: Hono, deps: ShellDeps): void {
  app.get("/audits", async (c) => {
    const ctx = await loadShellContext(c, deps, { activeNavId: "audits" });
    if (ctx.org === undefined) {
      return renderShell(
        c,
        ctx,
        { title: "tanren · scheduled audits" },
        <AuditsBody
          orgId=""
          snapshot={EMPTY}
          windowColumns={[]}
          lowNames={[]}
          error="link an org to schedule audits."
          csrfToken={ctx.csrfToken}
        />,
      );
    }
    const snapshot = (await readAuditsClient(c, deps).snapshot(ctx.org.id)) ?? EMPTY;
    const { records, unavailable: recordsUnavailable } = await gatherRecords(c, deps, ctx.org.id);
    const matrix = buildHeatmap(records, { now: new Date() });
    const columns = windowFillColumns(matrix);
    return renderShell(
      c,
      ctx,
      { title: "tanren · scheduled audits" },
      <AuditsBody
        orgId={ctx.org.id}
        snapshot={snapshot}
        windowColumns={columns}
        lowNames={underfilledNames(columns)}
        heatmapUnavailable={recordsUnavailable}
        csrfToken={ctx.csrfToken}
      />,
    );
  });

  app.post("/audits", async (c) => {
    const ctx = await loadShellContext(c, deps, { activeNavId: "audits" });
    if (ctx.org !== undefined) {
      const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
      const kind = str(form, "kind") as AuditKind;
      const cadence = str(form, "cadence") as AuditCadence;
      const name = str(form, "name") || (kind ? `${kind} audit` : "");
      if (VALID_KINDS.has(kind) && VALID_CADENCES.has(cadence) && name !== "") {
        await (
          await writeAuditsClient(c, deps)
        ).create(ctx.org.id, {
          kind,
          name,
          cadence,
          projectId: null,
          targetWindow: str(form, "targetWindow"),
          answererCli: str(form, "answererCli"),
        });
      }
    }
    return c.redirect("/audits");
  });

  for (const verb of ["enable", "disable"] as const) {
    app.post(`/audits/:jobId/${verb}`, async (c) => {
      const ctx = await loadShellContext(c, deps, { activeNavId: "audits" });
      if (ctx.org !== undefined) {
        await (await writeAuditsClient(c, deps)).setEnabled(ctx.org.id, c.req.param("jobId"), verb === "enable");
      }
      return c.redirect("/audits");
    });
  }

  app.post("/audits/:jobId/run", async (c) => {
    const ctx = await loadShellContext(c, deps, { activeNavId: "audits" });
    if (ctx.org !== undefined) {
      await (await writeAuditsClient(c, deps)).run(ctx.org.id, c.req.param("jobId"));
    }
    return c.redirect("/audits");
  });
}
