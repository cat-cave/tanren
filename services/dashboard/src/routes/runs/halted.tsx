/**
 * P2B-0008 failure-recovery routes. Mounted via the append-only screen registry
 * (`SCREEN_MOUNTS`) — appended AFTER P2B-0004's run-detail mount so the literal
 * `/runs/halted` resolves to this list page (P2B-0004's `/runs/:runId` handler
 * delegates the `halted` literal back via `next()`).
 *
 * Owns ONLY P2B-0008 paths — its own file, no edits to P2B-0004's
 * `routes/runs/index.tsx`:
 *   GET  /runs/halted                              — halted-run list
 *   GET  /runs/:runId/recover                      — per-run recovery surface
 *   POST /runs/:runId/recover/revise               — revise_spec
 *   POST /runs/:runId/recover/replan               — replan_with_steering
 *   POST /runs/:runId/recover/rollback             — rollback_to_commit
 *   POST /runs/:runId/recover/inspection-thread    — open_inspection_thread
 *
 * The four POST handlers are same-origin proxies: they reuse the inbound
 * session cookie via the typed `OrchestratorClient` recovery methods (keeping
 * the orchestrator URL server-side, per the `/forge/tools` precedent), then
 * render a templated acknowledgement.
 */

import type { Context, Hono } from "hono";
import { OrchestratorClient } from "../../api/orchestrator.js";
import { isRecoverableRun, type RecoveryActionResult, type RunLocation } from "../../api/types.js";
import { loadShellContext, renderShell, type ShellDeps } from "../../app/mountShell.js";
import { HaltedRunBody } from "../../components/recovery/HaltedRunBody.js";
import { RECOVERY_CSS } from "../../components/recovery/recovery.css.js";

export function mountHaltedRunScreens(app: Hono, deps: ShellDeps): void {
  // -------------------------------------------------------------------------
  // GET /runs/halted — the halted-run list (sidenav "halted runs" row).
  // -------------------------------------------------------------------------
  app.get("/runs/halted", async (c) => {
    const client = clientFor(c, deps);
    const orgs = await client.listOrgs();
    const halted: Array<{ runId: string; specTitle: string; outcome: string | null; projectName: string }> = [];
    for (const org of orgs) {
      const projects = await client.listProjects(org.id);
      for (const project of projects) {
        const runs = await client.listRuns(org.id, project.projectId);
        for (const run of runs) {
          if (isRecoverableRun(run)) {
            halted.push({
              runId: run.runId,
              specTitle: run.specTitle,
              outcome: run.outcome,
              projectName: project.name
            });
          }
        }
      }
    }
    const ctx = await loadShellContext(c, deps, { activeNavId: "failure" });
    return renderShell(c, ctx, { title: "tanren · halted runs" }, <HaltedListBody runs={halted} />);
  });

  // -------------------------------------------------------------------------
  // GET /runs/:runId/recover — the per-run failure-recovery surface.
  // -------------------------------------------------------------------------
  app.get("/runs/:runId/recover", async (c) => {
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
    if (!isRecoverableRun(detail.run)) {
      return renderNotRecoverable(c, deps, runId);
    }
    const recovery = await client.getRecoveryContext(loc, runId);
    const specs = await client.listSpecs(loc.orgId, loc.projectId);
    const ctx = await loadShellContext(c, deps, { activeNavId: "failure", projectId: loc.projectId });
    const base = `/runs/${encodeURIComponent(runId)}`;
    return renderShell(
      c,
      ctx,
      { title: `tanren · recover ${runId}` },
      <HaltedRunBody
        detail={detail}
        lastGoodCommit={recovery?.lastGoodCommit ?? null}
        specs={specs.map((s) => ({ specId: s.specId, title: s.title, dependsOn: s.dependsOn }))}
        actionBase={`${base}/recover`}
        projectHref={`/projects/${encodeURIComponent(loc.projectId)}`}
        runHref={base}
      />
    );
  });

  // -------------------------------------------------------------------------
  // POST recovery actions — same-origin proxies to the orchestrator routes.
  // -------------------------------------------------------------------------
  app.post("/runs/:runId/recover/revise", async (c) =>
    handleAction(c, deps, "revise_spec", async (client, loc, runId) => client.recoveryRevise(loc, runId))
  );

  app.post("/runs/:runId/recover/replan", async (c) => {
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const steeringNote = typeof form["steeringNote"] === "string" ? form["steeringNote"].trim() : "";
    if (steeringNote === "") {
      return handleActionError(c, deps, c.req.param("runId"), "a steering note is required to replan");
    }
    return handleAction(c, deps, "replan_with_steering", async (client, loc, runId) =>
      client.recoveryReplan(loc, runId, steeringNote)
    );
  });

  app.post("/runs/:runId/recover/rollback", async (c) => {
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const commitSha = typeof form["commitSha"] === "string" ? form["commitSha"] : "";
    const confirmed = form["confirmed"] === "true" || form["confirmed"] === "on";
    if (!confirmed) {
      return handleActionError(c, deps, c.req.param("runId"), "rollback was not confirmed — workspace state preserved");
    }
    return handleAction(c, deps, "rollback_to_commit", async (client, loc, runId) =>
      client.recoveryRollback(loc, runId, { commitSha, confirmed })
    );
  });

  app.post("/runs/:runId/recover/inspection-thread", async (c) =>
    handleAction(c, deps, "open_inspection_thread", async (client, loc, runId) =>
      client.recoveryInspectionThread(loc, runId)
    )
  );
}

type ActionCall = (
  client: OrchestratorClient,
  loc: RunLocation,
  runId: string
) => Promise<RecoveryActionResult>;

async function handleAction(
  c: Context,
  deps: ShellDeps,
  action: string,
  call: ActionCall
): Promise<Response> {
  const runId = c.req.param("runId") ?? "";
  const client = clientFor(c, deps);
  const loc = await client.findRunLocation(runId);
  if (loc === undefined) {
    return renderNotFound(c, deps, runId);
  }
  const result = await call(client, loc, runId);
  const ctx = await loadShellContext(c, deps, { activeNavId: "failure", projectId: loc.projectId });
  if (!result.ok) {
    return renderShell(
      c,
      ctx,
      { title: "tanren · recovery failed" },
      <RecoveryAck
        runId={runId}
        action={action}
        ok={false}
        message={result.message ?? result.error ?? "the recovery action could not be completed"}
        recoverHref={`/runs/${encodeURIComponent(runId)}/recover`}
      />
    );
  }
  return renderShell(
    c,
    ctx,
    { title: "tanren · recovery applied" },
    <RecoveryAck
      runId={runId}
      action={action}
      ok={true}
      result={result.result}
      recoverHref={`/runs/${encodeURIComponent(runId)}/recover`}
    />
  );
}

function handleActionError(c: Context, deps: ShellDeps, runId: string, message: string): Promise<Response> {
  return loadShellContext(c, deps, { activeNavId: "failure" }).then((ctx) =>
    renderShell(
      c,
      ctx,
      { title: "tanren · recovery failed" },
      <RecoveryAck
        runId={runId}
        action="recovery"
        ok={false}
        message={message}
        recoverHref={`/runs/${encodeURIComponent(runId)}/recover`}
      />
    )
  );
}

function clientFor(c: Context, deps: ShellDeps): OrchestratorClient {
  return new OrchestratorClient({
    orchestratorUrl: deps.orchestratorUrl,
    cookieHeader: c.req.header("cookie")
  });
}

function renderNotFound(c: Context, deps: ShellDeps, runId: string) {
  return loadShellContext(c, deps, { activeNavId: "failure" }).then((ctx) =>
    renderShell(c, ctx, { title: "tanren · run not found" }, <RecoverNotFoundBody runId={runId} kind="not_found" />)
  );
}

function renderNotRecoverable(c: Context, deps: ShellDeps, runId: string) {
  return loadShellContext(c, deps, { activeNavId: "failure" }).then((ctx) =>
    renderShell(c, ctx, { title: "tanren · nothing to recover" }, <RecoverNotFoundBody runId={runId} kind="not_recoverable" />)
  );
}

function HaltedListBody(props: {
  runs: Array<{ runId: string; specTitle: string; outcome: string | null; projectName: string }>;
}) {
  return (
    <>
      <style>{RECOVERY_CSS}</style>
      <div class="page-head">
        <div>
          <div class="eyebrow" style="color: var(--status-fail)">▮ halted runs · need a recovery</div>
          <div class="page-title">halted runs</div>
          <div class="sub">{props.runs.length} run(s) waiting on an operator recovery</div>
        </div>
      </div>
      <div class="page-body">
        {props.runs.length === 0 ? (
          <section class="placeholder-card">
            <p>No halted runs. Everything is moving.</p>
            <p class="placeholder-note">
              Runs surface here when they halt (<code>halted</code>, <code>escape_hatch_hit</code>,{" "}
              <code>retry_budget_exhausted</code>, <code>window_exhausted</code>).
            </p>
          </section>
        ) : (
          <div class="recovery-rail">
            {props.runs.map((run) => (
              <a class="recovery-card" href={`/runs/${encodeURIComponent(run.runId)}/recover`}>
                <div class="lbl">{run.specTitle}</div>
                <div class="t">
                  {run.projectName} · {run.runId}
                </div>
                <div class="det">
                  halted · <b style="color: var(--status-fail)">{run.outcome ?? "halted"}</b> — open the recovery surface
                  to revise, replan, rollback, or inspect.
                </div>
              </a>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function RecoverNotFoundBody(props: { runId: string; kind: "not_found" | "not_recoverable" }) {
  const recoverable = props.kind === "not_recoverable";
  return (
    <>
      <div class="page-head">
        <div>
          <div class="eyebrow">recovery · {recoverable ? "nothing to recover" : "not found"}</div>
          <div class="page-title">{recoverable ? "run is not halted" : "run not visible"}</div>
        </div>
      </div>
      <div class="page-body">
        <section class="placeholder-card">
          <p>
            {recoverable ? (
              <>
                Run <code>{props.runId}</code> is not in a recoverable state — only halted runs route here.
              </>
            ) : (
              <>
                No run <code>{props.runId}</code> is visible to you, or it has not started yet.
              </>
            )}
          </p>
          <p class="placeholder-note">
            <a href="/runs/halted">← back to halted runs</a>
          </p>
        </section>
      </div>
    </>
  );
}

function RecoveryAck(props: {
  runId: string;
  action: string;
  ok: boolean;
  result?: Record<string, unknown>;
  message?: string;
  recoverHref: string;
}) {
  const editHref = typeof props.result?.["editHref"] === "string" ? props.result["editHref"] : undefined;
  const replanRunId = typeof props.result?.["replanRunId"] === "string" ? props.result["replanRunId"] : undefined;
  const threadId = typeof props.result?.["threadId"] === "string" ? props.result["threadId"] : undefined;
  return (
    <>
      <style>{RECOVERY_CSS}</style>
      <div class="page-head">
        <div>
          <div class="eyebrow" style={props.ok ? undefined : "color: var(--status-fail)"}>
            recovery · {props.action}
          </div>
          <div class="page-title">{props.ok ? "recovery applied" : "recovery not applied"}</div>
          <div class="sub">run {props.runId}</div>
        </div>
      </div>
      <div class="page-body">
        <section class={props.ok ? "recovery-ack" : "recovery-ack fail"}>
          {props.ok ? (
            <>
              <div class="h">{ackHeadline(props.action)}</div>
              <div class="b">
                {props.action === "revise_spec" && editHref !== undefined && (
                  <>
                    The revision intent is recorded in the run lineage. <a href={editHref}>open the spec-edit form ↗</a> —
                    on submit, the planner is re-invoked with the revised spec.
                  </>
                )}
                {props.action === "replan_with_steering" && (
                  <>
                    Your steering note was appended to the spec and a fresh planner run was queued
                    {replanRunId !== undefined ? (
                      <>
                        {" "}
                        (<a href={`/runs/${encodeURIComponent(replanRunId)}`}>{replanRunId} ↗</a>)
                      </>
                    ) : null}
                    . The re-plan runs the P2A-0012 loop to completion.
                  </>
                )}
                {props.action === "rollback_to_commit" && (
                  <>
                    The workspace was rolled back to the known-good commit and a fresh run was queued
                    {replanRunId !== undefined ? (
                      <>
                        {" "}
                        (<a href={`/runs/${encodeURIComponent(replanRunId)}`}>{replanRunId} ↗</a>)
                      </>
                    ) : null}
                    .
                  </>
                )}
                {props.action === "open_inspection_thread" && (
                  <>
                    An inspection thread <code>{threadId}</code> is now bound to this run with read access to the
                    auditor/writer disagreement history. Reading it changes no state.
                  </>
                )}
              </div>
              <p class="placeholder-note">
                <a href={props.recoverHref}>← back to recovery</a>
              </p>
            </>
          ) : (
            <>
              <div class="h">recovery not applied</div>
              <div class="b">{props.message}</div>
              <p class="placeholder-note">
                <a href={props.recoverHref}>← back to recovery</a>
              </p>
            </>
          )}
        </section>
      </div>
    </>
  );
}

function ackHeadline(action: string): string {
  switch (action) {
    case "revise_spec":
      return "spec revision routed";
    case "replan_with_steering":
      return "replan queued with your steering";
    case "rollback_to_commit":
      return "rolled back + re-queued";
    case "open_inspection_thread":
      return "inspection thread opened";
    default:
      return "recovery applied";
  }
}
