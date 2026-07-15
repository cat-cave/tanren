/**
 * Shared, accessible UI for definitive run-location misses vs fail-closed
 * unavailable/auth outcomes. Used by run-detail and recovery routes so both
 * surfaces speak the same honest status vocabulary.
 */

import type { Context } from "hono";
import type { FindRunLocationResult } from "../../api/runLocation.js";
import { loadShellContext, renderShell, type ShellDeps } from "../../app/mountShell.js";

export type LocationFailureStatus = 401 | 403 | 404 | 502;

export function httpStatusForLocationResult(
  result: Exclude<FindRunLocationResult, { kind: "found" }>,
): LocationFailureStatus {
  if (result.kind === "not_found") return 404;
  if (result.kind === "auth") return result.status;
  return 502;
}

export function streamTextForLocationResult(result: Exclude<FindRunLocationResult, { kind: "found" }>): string {
  if (result.kind === "not_found") return "run not found";
  if (result.kind === "auth") return "run location unauthorized";
  return "run location unavailable";
}

async function withHtmlStatus(response: Response | Promise<Response>, status: number): Promise<Response> {
  const resolved = await response;
  return new Response(resolved.body, { status, headers: resolved.headers });
}

export function renderRunLocationFailure(
  c: Context,
  deps: ShellDeps,
  runId: string,
  result: Exclude<FindRunLocationResult, { kind: "found" }>,
  activeNavId: string,
): Promise<Response> {
  const status = httpStatusForLocationResult(result);
  if (result.kind === "not_found") {
    return loadShellContext(c, deps, { activeNavId }).then((ctx) =>
      withHtmlStatus(
        renderShell(c, ctx, { title: "tanren · run not found" }, <RunNotFoundBody runId={runId} />),
        status,
      ),
    );
  }
  if (result.kind === "auth") {
    return loadShellContext(c, deps, { activeNavId }).then((ctx) =>
      withHtmlStatus(
        renderShell(
          c,
          ctx,
          { title: "tanren · run unauthorized" },
          <RunLocationProblemBody
            runId={runId}
            kind="auth"
            status={result.status}
            message="You are not authorized to resolve this run's location. Sign in again or ask an org admin for access."
          />,
        ),
        status,
      ),
    );
  }
  const reasonNote =
    result.reason === "ambiguous"
      ? "More than one organization reported this run, or a probe was inconclusive — refusing to guess."
      : result.reason === "network"
        ? "The orchestrator could not be reached while resolving this run."
        : result.reason === "malformed"
          ? "The orchestrator returned an unexpected location payload."
          : "The orchestrator was unavailable or returned an error while resolving this run.";
  return loadShellContext(c, deps, { activeNavId }).then((ctx) =>
    withHtmlStatus(
      renderShell(
        c,
        ctx,
        { title: "tanren · run unavailable" },
        <RunLocationProblemBody runId={runId} kind="unavailable" status={status} message={reasonNote} />,
      ),
      status,
    ),
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
        <section class="placeholder-card" role="status" data-run-location="not_found" aria-live="polite">
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

function RunLocationProblemBody(props: {
  runId: string;
  kind: "auth" | "unavailable";
  status: number;
  message: string;
}) {
  const eyebrow = props.kind === "auth" ? "run · unauthorized" : "run · unavailable";
  const title = props.kind === "auth" ? "cannot authorize run location" : "run location unavailable";
  return (
    <>
      <div class="page-head">
        <div>
          <div class="eyebrow">{eyebrow}</div>
          <div class="page-title">{title}</div>
        </div>
      </div>
      <div class="page-body">
        <section
          class="placeholder-card"
          role="alert"
          data-run-location={props.kind}
          data-run-location-status={String(props.status)}
          aria-live="assertive"
        >
          <p>
            Could not resolve run <code>{props.runId}</code>.
          </p>
          <p>{props.message}</p>
          <p class="placeholder-note">
            <a href="/projects">← back to projects</a>
          </p>
        </section>
      </div>
    </>
  );
}
