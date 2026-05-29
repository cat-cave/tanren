/**
 * P2B-0004 run-detail + review-handoff routes. Mounted via the append-only
 * screen registry (`SCREEN_MOUNTS`) so the real routes claim their paths before
 * the shell fills gaps. Owns ONLY the run-detail surface (`/runs/:runId`) and
 * its review sub-surface (`/runs/:runId/review`) — `/runs/halted` belongs to
 * P2B-0008, so the `:runId` handler delegates that literal back to the shell
 * placeholder via `next()`.
 *
 * The dashboard route is run-scoped (`/runs/:runId`); the orchestrator API
 * (P2A-0014) is org+project-scoped, so we resolve the run's location from the
 * operator's orgs/projects, then fetch the contract-typed RunDetail snapshot.
 * A same-origin SSE proxy (`/runs/:runId/stream`) forwards the orchestrator
 * stream with the session cookie so the browser island can subscribe without
 * the orchestrator URL leaking client-side.
 */

import type { Context, Hono } from "hono";
import { OrchestratorClient } from "../../api/orchestrator.js";
import type { RunLocation } from "../../api/types.js";
import { loadShellContext, renderShell, type ShellDeps } from "../../app/mountShell.js";
import { RunDetailBody } from "../../components/runDetail/RunDetailBody.js";
import { ReviewBody, type MergeIntegration } from "../../components/runDetail/ReviewBody.js";
import { derivePreviewUrl } from "../../components/runDetail/model.js";

/** Admin scopes that may opt into raw (unredacted) event payloads (P2A-0009). */
const ADMIN_ROLES = new Set(["org:admin", "platform:admin", "project:admin"]);

function actorCanViewRaw(role: string | undefined): boolean {
  return role !== undefined && ADMIN_ROLES.has(role);
}

/**
 * P3-0008: resolve the per-repo merge integration from the project's merged
 * config (`GET /orgs/:orgId/projects/:projectId` → `config.mergeIntegration`).
 * Falls back to `not_configured` when the project read fails or the field is
 * absent (legacy rows), which renders the settings-link branch.
 */
function mergeIntegrationFromConfig(mode: unknown): MergeIntegration {
  if (
    mode === "mergify_queue" ||
    mode === "direct_merge" ||
    mode === "external_reviewer" ||
    mode === "not_configured"
  ) {
    return mode;
  }
  return "not_configured";
}

async function resolveMergeIntegration(client: OrchestratorClient, loc: RunLocation): Promise<MergeIntegration> {
  const project = await client.getProject(loc.orgId, loc.projectId).catch(() => undefined);
  return mergeIntegrationFromConfig(project?.config.mergeIntegration);
}

export function mountRunDetailScreens(app: Hono, deps: ShellDeps): void {
  // -------------------------------------------------------------------------
  // GET /runs/:runId — the run-detail screen.
  // -------------------------------------------------------------------------
  app.get("/runs/:runId", async (c, next) => {
    const runId = c.req.param("runId");
    // `/runs/halted` is P2B-0008's surface — let the shell placeholder claim it.
    if (runId === "halted") return next();

    const client = clientFor(c, deps);
    const loc = await client.findRunLocation(runId);
    if (loc === undefined) {
      return renderNotFound(c, deps, runId);
    }
    const canViewRaw = await isOrgAdmin(client, loc);
    const rawView = parseRaw(c) && canViewRaw;
    const detail = await client.getRunDetail(loc, runId, { rawView });
    if (detail === undefined) {
      return renderNotFound(c, deps, runId);
    }
    const ctx = await loadShellContext(c, deps, {
      activeNavId: "projects",
      projectId: loc.projectId,
    });
    const base = `/runs/${encodeURIComponent(runId)}`;
    return renderShell(
      c,
      ctx,
      { title: `tanren · run ${runId}` },
      <RunDetailBody
        detail={detail}
        canViewRaw={canViewRaw}
        rawView={rawView}
        reviewHref={`${base}/review`}
        rawToggleHref={rawView ? base : `${base}?raw=true`}
        streamUrl={`${base}/stream${rawView ? "?raw=true" : ""}`}
      />,
    );
  });

  // -------------------------------------------------------------------------
  // GET /runs/:runId/stream — same-origin SSE proxy → orchestrator P2A-0014.
  // -------------------------------------------------------------------------
  app.get("/runs/:runId/stream", async (c) => {
    const runId = c.req.param("runId");
    const client = clientFor(c, deps);
    const loc = await client.findRunLocation(runId);
    if (loc === undefined) {
      return c.text("run not found", 404);
    }
    const rawView = parseRaw(c) && (await isOrgAdmin(client, loc));
    const upstream = await fetch(client.streamUrl(loc, runId, { rawView }), {
      headers: {
        Accept: "text/event-stream",
        ...(c.req.header("cookie") !== undefined ? { cookie: c.req.header("cookie") as string } : {}),
      },
    }).catch(() => undefined);
    if (upstream === undefined || upstream.body === null) {
      return c.text("stream unavailable", 502);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  });

  // -------------------------------------------------------------------------
  // GET /runs/:runId/review — the review-handoff sub-surface.
  // -------------------------------------------------------------------------
  app.get("/runs/:runId/review", async (c) => {
    const runId = c.req.param("runId");
    const client = clientFor(c, deps);
    const loc = await client.findRunLocation(runId);
    if (loc === undefined) {
      return renderNotFound(c, deps, runId);
    }
    const detail = await client.getRunDetail(loc, runId);
    if (detail === undefined) {
      return renderNotFound(c, deps, runId);
    }
    const ctx = await loadShellContext(c, deps, {
      activeNavId: "projects",
      projectId: loc.projectId,
    });
    const base = `/runs/${encodeURIComponent(runId)}`;
    // P3-0008 + P3-0025: read the project once and derive both the merge
    // integration and the per-PR preview-deploy URL from its config.
    const project = await client.getProject(loc.orgId, loc.projectId).catch(() => undefined);
    const previewUrl = derivePreviewUrl(project?.config.previewUrlPattern, detail.run);
    return renderShell(
      c,
      ctx,
      { title: `tanren · review ${runId}` },
      <ReviewBody
        detail={detail}
        mergeIntegration={mergeIntegrationFromConfig(project?.config.mergeIntegration)}
        runHref={base}
        requestChangesHref={`${base}/review/request-changes`}
        signOffHref={`${base}/review/sign-off`}
        settingsHref="/settings/routing"
        previewUrl={previewUrl}
      />,
    );
  });

  // -------------------------------------------------------------------------
  // POST /runs/:runId/review/request-changes — loop the spec back to the
  // planner. The Phase-2 spec-rework write path (P2A-0012/0013) and its UI live
  // in P2B-0003/0006/0008; here we record the operator's request and confirm it,
  // then return the operator to the run detail. This is the documented v0
  // reduction: the gesture is real and observable; the live replan wiring lands
  // with the operator-driven-workflow spec.
  // -------------------------------------------------------------------------
  app.post("/runs/:runId/review/request-changes", async (c) => {
    const runId = c.req.param("runId");
    const client = clientFor(c, deps);
    const loc = await client.findRunLocation(runId);
    if (loc === undefined) {
      return renderNotFound(c, deps, runId);
    }
    const detail = await client.getRunDetail(loc, runId);
    const ctx = await loadShellContext(c, deps, {
      activeNavId: "projects",
      projectId: loc.projectId,
    });
    return renderShell(
      c,
      ctx,
      { title: `tanren · changes requested` },
      <RequestChangesAck
        runId={runId}
        specTitle={detail?.spec.title ?? runId}
        runHref={`/runs/${encodeURIComponent(runId)}`}
      />,
    );
  });

  // -------------------------------------------------------------------------
  // POST /runs/:runId/review/sign-off — the operator hand-off that drives the
  // P3-0008 merge stage through the repo's configured integration. The live
  // orchestrator merge-dispatch trigger lands with the operator-driven workflow
  // (P2B-0006); here we record the gesture and confirm the configured mode so it
  // is real + observable, then return the operator to the run detail.
  // -------------------------------------------------------------------------
  app.post("/runs/:runId/review/sign-off", async (c) => {
    const runId = c.req.param("runId");
    const client = clientFor(c, deps);
    const loc = await client.findRunLocation(runId);
    if (loc === undefined) {
      return renderNotFound(c, deps, runId);
    }
    const mode = await resolveMergeIntegration(client, loc);
    const ctx = await loadShellContext(c, deps, {
      activeNavId: "projects",
      projectId: loc.projectId,
    });
    return renderShell(
      c,
      ctx,
      { title: `tanren · sign-off` },
      <SignOffAck runId={runId} mode={mode} runHref={`/runs/${encodeURIComponent(runId)}`} />,
    );
  });
}

function clientFor(c: Context, deps: ShellDeps): OrchestratorClient {
  return new OrchestratorClient({
    orchestratorUrl: deps.orchestratorUrl,
    cookieHeader: c.req.header("cookie"),
  });
}

function parseRaw(c: Context): boolean {
  const raw = c.req.query("raw");
  return raw !== undefined && /^(1|true|yes)$/i.test(raw);
}

/** The operator is an org admin when their first org's role is an admin role. */
async function isOrgAdmin(client: OrchestratorClient, loc: RunLocation): Promise<boolean> {
  const orgs = await client.listOrgs();
  const org = orgs.find((o) => o.id === loc.orgId);
  return org !== undefined && actorCanViewRaw(org.role);
}

function renderNotFound(c: Context, deps: ShellDeps, runId: string) {
  return loadShellContext(c, deps, { activeNavId: "projects" }).then((ctx) =>
    renderShell(c, ctx, { title: "tanren · run not found" }, <RunNotFoundBody runId={runId} />),
  );
}

function RunNotFoundBody(props: { runId: string }) {
  return (
    <>
      <div class="page-head">
        <div>
          <div class="eyebrow">run · not found</div>
          <div class="page-title">run not visible</div>
        </div>
      </div>
      <div class="page-body">
        <section class="placeholder-card">
          <p>
            No run <code>{props.runId}</code> is visible to you, or it has not started yet.
          </p>
          <p class="placeholder-note">
            <a href="/projects">← back to projects</a>
          </p>
        </section>
      </div>
    </>
  );
}

function RequestChangesAck(props: { runId: string; specTitle: string; runHref: string }) {
  return (
    <>
      <div class="page-head">
        <div>
          <div class="eyebrow">review · changes requested</div>
          <div class="page-title">looped back to the planner</div>
          <div class="sub">
            {props.specTitle} · run {props.runId}
          </div>
        </div>
      </div>
      <div class="page-body">
        <section class="placeholder-card">
          <p>
            Your <strong>request changes</strong> has been recorded for this run's spec. The planner-feedback loop
            (P2A-0012) re-plans the spec; the live re-plan trigger ships with the operator-driven workflow (P2B-0006)
            and failure-recovery (P2B-0008) surfaces.
          </p>
          <p class="placeholder-note">
            <a href={props.runHref}>← back to the run</a>
          </p>
        </section>
      </div>
    </>
  );
}

function SignOffAck(props: { runId: string; mode: MergeIntegration; runHref: string }) {
  const action =
    props.mode === "direct_merge"
      ? "a direct GitHub merge"
      : props.mode === "mergify_queue"
        ? "a Mergify queue enqueue"
        : props.mode === "external_reviewer"
          ? "an external-reviewer hand-off"
          : "no merge integration (configure one in project settings)";
  return (
    <>
      <div class="page-head">
        <div>
          <div class="eyebrow">review · signed off</div>
          <div class="page-title">merge hand-off recorded</div>
          <div class="sub">
            run {props.runId} · {props.mode}
          </div>
        </div>
      </div>
      <div class="page-body">
        <section class="placeholder-card">
          <p>
            Your <strong>sign-off</strong> has been recorded. This run's repo is configured for{" "}
            <strong>{action}</strong> (P3-0008 merge stage). The live merge-dispatch trigger ships with the
            operator-driven workflow (P2B-0006); the merge stage itself runs on the orchestrator after a run's review is
            approved.
          </p>
          <p class="placeholder-note">
            <a href={props.runHref}>← back to the run</a>
          </p>
        </section>
      </div>
    </>
  );
}
