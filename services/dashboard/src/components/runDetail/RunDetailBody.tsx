/**
 * RunDetailBody — the run-detail screen rendered server-side inside
 * the shell. Recreated from the hi-fi `view-run.jsx`:
 *   - page head (eyebrow + title + run/spec/branch sub-line + action buttons)
 *   - unified cost bar (per-token, window, tokens in/out, spend rate, run meta)
 *   - trajectory spine (left) — clickable moments, spine fills with progress
 *   - writer reasoning pane (right) — intent / BDD / tools / decisions
 *   - events list with redacted/raw access
 *   - PR/CI chips + failure diagnostics
 */

import type { RunDetail, RunEventRow } from "../../api/types.js";
import {
  buildTrajectory,
  costSourceLabel,
  costSourceVar,
  failedTasks,
  formatDuration,
  formatTokens,
  formatUsd,
  reasoningForTask,
  runFailed,
  spineProgress,
  summarizeCosts,
  type TrajectoryMoment,
} from "./model.js";
import { RUN_DETAIL_CSS } from "./runDetail.css.js";

export interface RunDetailBodyProps {
  detail: RunDetail;
  /** True when the operator has elevated scope (admin) — gates the raw toggle. */
  canViewRaw: boolean;
  /** Currently requested raw view (from `?raw=true`). */
  rawView: boolean;
  /** Path to the review handoff for this run. */
  reviewHref: string;
  /** Path to (re-)render this page with raw events on/off. */
  rawToggleHref: string;
  /** Same-origin SSE proxy URL the client island subscribes to for live updates. */
  streamUrl: string;
}

function relativeAgo(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function CostBar(props: { detail: RunDetail }) {
  const { detail } = props;
  const totals = summarizeCosts(detail.costs);
  const liveTask = detail.tasks.find((t) => t.status === "running" || t.status === "claimed");
  const attempts = detail.tasks.reduce((max, t) => Math.max(max, t.attempt + 1), 1);
  const retries = detail.tasks.reduce((sum, t) => sum + t.attempt, 0);
  const inPct =
    totals.inputTokens + totals.outputTokens === 0
      ? 0
      : (totals.inputTokens / (totals.inputTokens + totals.outputTokens)) * 100;
  return (
    <div class="cost-bar" data-rd="cost-bar">
      {/* per-token: real dollars */}
      <div class="cost-cell">
        <div class="row1">
          <span class="swatch" style="background: var(--cost-token)"></span>
          <span class="l" style="color: var(--cost-token)">
            per-token
          </span>
          <span class="v" data-rd="cost-per-token">
            {formatUsd(totals.perTokenUsd)}
          </span>
        </div>
        <div class="bar">
          <i style={`width: ${Math.min(100, totals.perTokenUsd * 100).toFixed(1)}%; background: var(--cost-token)`}></i>
        </div>
        <div class="k">real-dollar spend · {totals.bySource.get("per_token")?.tokens ?? 0} tok</div>
      </div>
      {/* window: subscription usage by source */}
      <div class="cost-cell">
        <div class="row1">
          <span class="swatch" style="background: var(--cost-window)"></span>
          <span class="l" style="color: var(--cost-window)">
            window
          </span>
          <span class="v">{formatTokens(totals.bySource.get("subscription")?.tokens ?? 0)}</span>
        </div>
        <div class="source-rows" data-rd="cost-sources">
          {[...totals.bySource.entries()].map(([mode, agg]) => (
            <div class="source-row">
              <span class="sw" style={`background: ${costSourceVar(mode)}`}></span>
              <span>{costSourceLabel(mode)}</span>
              <span class="amt">
                {formatTokens(agg.tokens)} tok{agg.usd > 0 ? ` · ${formatUsd(agg.usd)}` : ""}
              </span>
            </div>
          ))}
        </div>
      </div>
      {/* tokens in / out */}
      <div class="cost-cell">
        <div class="row1">
          <span class="l" style="color: var(--fg-3)">
            tokens · in / out
          </span>
          <span class="v" data-rd="cost-tokens">
            {formatTokens(totals.inputTokens)} / {formatTokens(totals.outputTokens)}
          </span>
        </div>
        <div class="bar" style="display:flex; gap:2px;">
          <i style={`width:${inPct.toFixed(1)}%; background: var(--line-2)`}></i>
          <i style={`width:${(100 - inPct).toFixed(1)}%; background: var(--cost-token)`}></i>
        </div>
        <div class="k">
          cached {formatTokens(totals.cachedInputTokens)} · total {formatTokens(totals.totalTokens)}
        </div>
      </div>
      {/* per-model breakdown (spend rate cell repurposed to real model attribution) */}
      <div class="cost-cell">
        <div class="row1">
          <span class="l" style="color: var(--fg-3)">
            by model
          </span>
        </div>
        <div class="source-rows">
          {totals.byModel.size === 0 ? (
            <div class="source-row">
              <span>no cost records yet</span>
            </div>
          ) : (
            [...totals.byModel.entries()].map(([model, agg]) => (
              <div class="source-row">
                <span>{model}</span>
                <span class="amt">{formatTokens(agg.tokens)} tok</span>
              </div>
            ))
          )}
        </div>
      </div>
      {/* run meta */}
      <div class="cost-cell meta-cell">
        <div class="grid">
          <span class="k">cli</span>
          <b>{liveTask?.cli ?? detail.tasks[0]?.cli ?? "—"}</b>
          <span class="k">attempt</span>
          <b data-rd="meta-attempt">{attempts}</b>
          <span class="k">elapsed</span>
          <b data-rd="meta-elapsed">{formatDuration(detail.run.startedAt, detail.run.endedAt) || "—"}</b>
          <span class="k">retries</span>
          <b style={retries > 0 ? "color: var(--status-warn)" : "color: var(--status-ok)"}>{retries}</b>
        </div>
      </div>
    </div>
  );
}

function TrajectoryRow(props: { moment: TrajectoryMoment; index: number; selected: boolean }) {
  const { moment, index, selected } = props;
  const cls = `traj-row${selected ? " selected" : ""}${moment.state === "queued" ? " queued" : ""}`;
  const glyph = moment.state === "done" ? "✓" : moment.state === "live" ? "↻" : moment.state === "failed" ? "×" : "";
  return (
    <div class={cls} data-rd-moment={moment.taskId} data-rd-index={String(index)} role="button" tabindex={0}>
      <span class={`dot ${moment.state}`}>{glyph}</span>
      <div class="body-cell">
        <div class={`ph ${moment.state}`}>
          {moment.phase}
          {moment.duration === "" ? "" : ` · ${moment.duration}`}
        </div>
        <div class="t">{moment.title}</div>
        {moment.model === null ? null : (
          <div class="io">
            {moment.cli} · {moment.model}
          </div>
        )}
        {moment.failureKind === null ? null : (
          <div class="io" style="color: var(--status-fail)">
            {moment.failureKind}
          </div>
        )}
      </div>
    </div>
  );
}

function Trajectory(props: { detail: RunDetail; selectedTaskId: string | null }) {
  const moments = buildTrajectory(props.detail.tasks);
  const { donePct, livePct } = spineProgress(moments);
  const spineStyle = `background: linear-gradient(to bottom, var(--status-ok) 0%, var(--status-ok) ${donePct}%, var(--ember-08) ${donePct}%, var(--ember-08) ${livePct}%, var(--line-2) ${livePct}%);`;
  const terminal = ["completed", "failed", "cancelled", "halted"].includes(props.detail.run.status);
  return (
    <div class="rd-panel trajectory" data-rd="trajectory">
      <div class="rd-panel-head">
        <h3>trajectory</h3>
        <span class="live" data-rd="live-flag">
          {terminal ? "● final · verifying totals" : "↻ live"}
        </span>
      </div>
      <div class="rd-panel-body">
        <div class="spine" data-rd="spine" style={spineStyle}></div>
        {moments.length === 0 ? (
          <div style="padding: 14px; font-size: 12px; color: var(--fg-3)">no tasks yet · the planner has not run</div>
        ) : (
          moments.map((moment, i) => (
            <TrajectoryRow moment={moment} index={i} selected={moment.taskId === props.selectedTaskId} />
          ))
        )}
      </div>
      <div class="rd-foot">click any moment · spine fills as the run progresses</div>
    </div>
  );
}

function eventSummary(event: RunEventRow): string {
  const payload = event.payload;
  if (typeof payload === "object" && payload !== null) {
    const rec = payload as Record<string, unknown>;
    const summary = rec["summary"] ?? rec["headline"] ?? rec["title"] ?? rec["message"];
    if (typeof summary === "string") return summary;
    const keys = Object.keys(rec);
    return keys.length === 0 ? "(empty)" : `{ ${keys.slice(0, 4).join(", ")} }`;
  }
  // Past the object branch, `payload` is a primitive. Narrow per type so the
  // stringification is always well-defined (`String(symbol)` throws; an object
  // would `[object Object]`, but the object case already returned above).
  if (typeof payload === "string") return payload;
  if (typeof payload === "number" || typeof payload === "bigint" || typeof payload === "boolean") {
    return payload.toString();
  }
  if (typeof payload === "symbol") return payload.toString();
  return "";
}

function Reasoning(props: RunDetailBodyProps & { selectedTaskId: string | null }) {
  const { detail, selectedTaskId, canViewRaw, rawView, rawToggleHref } = props;
  const reasoning = reasoningForTask(detail, selectedTaskId);
  const task = detail.tasks.find((t) => t.taskId === selectedTaskId);
  const insightForTask = (detail.insights as Array<Record<string, unknown>>).find((ins) => {
    return typeof ins === "object" && ins !== null;
  });
  return (
    <div class="rd-panel" data-rd="reasoning">
      <div class="rd-panel-head">
        <h3>writer's reasoning</h3>
        <span class="pill run" style="margin-left:auto">
          <span class="d"></span>
          {task?.cli ?? "agent"} · live
        </span>
      </div>
      <div class="reason" data-rd="reason-body">
        <div>
          <div class="moment-eyebrow" data-rd="moment-eyebrow">
            moment · {task ? `${task.kind} · ${task.taskId}` : "select a moment"}
          </div>
          <h2 data-rd="moment-headline">{reasoning.headline}</h2>
        </div>

        {insightForTask !== undefined && typeof insightForTask["kind"] === "string" ? (
          <div class="subopt">
            <span class="tag">workflow insight · {insightForTask["kind"]}</span>
            <span class="t">
              {typeof insightForTask["specTitle"] === "string"
                ? insightForTask["specTitle"]
                : "a suboptimal pattern was detected on this run"}
            </span>
          </div>
        ) : null}

        <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
          <div>
            <h4>intent</h4>
            <div class="intent" data-rd="intent">
              {reasoning.intent ?? "No structured intent captured for this moment yet."}
            </div>
          </div>
          <div>
            <h4>demonstrates · bdd</h4>
            <div class="bdd">
              {detail.spec.behaviorIds.length === 0 ? (
                <div>no behaviors tagged on this spec</div>
              ) : (
                detail.spec.behaviorIds.map((b) => (
                  <div>
                    <span class="kw">behavior</span> · <code>{b}</code>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div>
          <h4>tools called · {reasoning.tools.length}</h4>
          <div style="display:flex; flex-direction:column; gap:6px; margin-top:6px;">
            {reasoning.tools.length === 0 ? (
              <div style="font-size:12px; color: var(--fg-3)">no structured tool calls in this moment's events</div>
            ) : (
              reasoning.tools.map((tool) => (
                <div class="tool-row">
                  <span class="g">↗</span>
                  <div>
                    <div class="name">
                      <b>{tool.name}</b> <span class="arg">{tool.arg}</span>
                    </div>
                    {tool.output === "" ? null : <div class="out">↑ {tool.output}</div>}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div>
          <h4>decisions</h4>
          {reasoning.decisions.length === 0 ? (
            <div style="font-size:12px; color: var(--fg-3)">no structured decisions captured for this moment</div>
          ) : (
            <ul class="decisions">
              {reasoning.decisions.map((d) => (
                <li>{d}</li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h4>
            events · this moment ({reasoning.events.length})
            {canViewRaw ? (
              <span class="raw-toggle" style="margin-left:8px; text-transform:none; letter-spacing:0;">
                <a href={rawToggleHref}>{rawView ? "view redacted" : "view raw ↗"}</a>
              </span>
            ) : null}
          </h4>
          <div class="events-list" data-rd="events-list">
            {reasoning.events.length === 0 ? (
              <div style="font-size:11px; color: var(--fg-3); font-family: var(--font-mono)">
                no events bound to this moment
              </div>
            ) : (
              reasoning.events.map((event) => (
                <div class="event-row">
                  <span class="et">{event.eventType}</span>
                  <span>
                    {eventSummary(event)}
                    {event.redactedPaths.length > 0 ? (
                      <span class="redacted"> · {event.redactedPaths.length} field(s) hidden by redaction</span>
                    ) : null}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        <a class="ask-forge-cta" href={`${props.reviewHref}?ask=1`} data-rd="ask-forge">
          <div class="l">↑ ask forge</div>
          <div class="t">why did the writer make this call? (opens a Forge thread bound to this moment)</div>
        </a>
      </div>
    </div>
  );
}

function StatusChips(props: { detail: RunDetail }) {
  const { detail } = props;
  const ciTask = detail.tasks.find((t) => t.kind === "ci");
  const ciState =
    ciTask === undefined ? "warn" : ciTask.outcome === "passed" ? "ok" : ciTask.status === "running" ? "warn" : "bad";
  const ciLabel =
    ciTask === undefined
      ? "ci pending"
      : ciTask.outcome === "passed"
        ? "ci green"
        : ciTask.status === "running"
          ? "ci running"
          : `ci ${ciTask.outcome ?? ciTask.status}`;
  const statusClass = detail.run.status === "completed" ? "ok" : runFailed(detail) ? "bad" : "warn";
  return (
    <div class="rd-chips" data-rd="chips">
      <span class={`rd-chip ${statusClass}`} data-rd="run-status">
        <span class="d"></span>run · {detail.run.status}
        {detail.run.outcome === null ? "" : ` · ${detail.run.outcome}`}
      </span>
      <span class={`rd-chip ${ciState}`}>
        <span class="d"></span>
        {ciLabel}
      </span>
      {detail.run.prUrl === null ? (
        <span class="rd-chip">
          <span class="d"></span>no pr yet
        </span>
      ) : (
        <span class="rd-chip">
          <span class="d"></span>pr ·{" "}
          <a href={detail.run.prUrl} target="_blank" rel="noreferrer">
            {detail.run.prUrl} ↗
          </a>
        </span>
      )}
    </div>
  );
}

function FailureDiagnostics(props: { detail: RunDetail }) {
  const failed = failedTasks(props.detail);
  if (!runFailed(props.detail) && failed.length === 0) return null;
  return (
    <div class="failure-banner">
      <h3>failure diagnostics</h3>
      <div class="diag">
        run outcome · {props.detail.run.outcome ?? props.detail.run.status}
        {failed.map((t) => (
          <div>
            · {t.kind} <b>{t.taskId}</b> — {t.outcome ?? t.status}
            {t.failureKind === null ? "" : ` (${t.failureKind})`}
            {" · attempt "}
            {t.attempt + 1}
          </div>
        ))}
        {props.detail.run.status === "halted" ? (
          <div style="margin-top:6px;">
            this run hit an escape hatch ·{" "}
            <a href="/runs/halted" style="color: var(--ember-08)">
              recover it ↗
            </a>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function RunDetailBody(props: RunDetailBodyProps) {
  const { detail } = props;
  // Default selection: the live task, else the most recently started one.
  const live = detail.tasks.find((t) => t.status === "running" || t.status === "claimed");
  const fallback = [...detail.tasks].sort((a, b) => {
    const sa = a.startedAt === null ? -1 : Date.parse(a.startedAt);
    const sb = b.startedAt === null ? -1 : Date.parse(b.startedAt);
    return sb - sa;
  })[0];
  const selectedTaskId = (live ?? fallback)?.taskId ?? null;

  return (
    <>
      <style>{RUN_DETAIL_CSS}</style>
      <div
        class="rd-root"
        data-island="run-stream"
        data-stream-url={props.streamUrl}
        data-run-id={detail.run.runId}
        data-project-id={detail.run.projectId}
        data-run-status={detail.run.status}
        data-run-outcome={detail.run.outcome ?? ""}
      >
        <div class="page-head">
          <div>
            <div class="eyebrow">▮ trajectory · scrub through everything</div>
            <div class="page-title">the agent's thinking</div>
            <div class="sub">
              {detail.run.runId} · {detail.spec.title} · started {relativeAgo(detail.run.startedAt)} · branch{" "}
              <code>{detail.run.branch}</code>
            </div>
          </div>
          <div class="rd-actions">
            <span class="pill run" data-rd="header-status">
              <span class="d"></span>
              {detail.run.status}
            </span>
            <a class="btn ghost" href={`/projects/${detail.run.projectId}`}>
              ← back to project
            </a>
            <a class="btn" href={`${props.reviewHref}?ask=1`} style="color: var(--ember-08)">
              鍛 ask why
            </a>
            <a class="btn" href={props.reviewHref}>
              review handoff
            </a>
          </div>
        </div>

        <div style="margin-top:12px"></div>
        <StatusChips detail={detail} />
        <FailureDiagnostics detail={detail} />
        <CostBar detail={detail} />

        <div class="page-body" style="padding:0;">
          <div class="split-run">
            <Trajectory detail={detail} selectedTaskId={selectedTaskId} />
            <Reasoning {...props} selectedTaskId={selectedTaskId} />
          </div>
        </div>
      </div>
    </>
  );
}
