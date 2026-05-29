/**
 * DAG-primary project view body (P3-0013). The full spec-graph canvas leads;
 * Forge is collapsed to a clickable pill on the right rail alongside velocity +
 * activity. A chat↔DAG toggle in the header switches modes (the chat-primary
 * view from P2B-0003 is the other mode; this is the alternate, not a forced
 * default). The toggle persists client-side like the theme toggle — see the
 * `dag-canvas` island + `data-mode-toggle`.
 */

import type { ProjectDag } from "../../api/projectDag.js";
import { DagCanvas } from "./DagCanvas.js";
import { DagStyles } from "./dagStyles.js";
import { ScreenStyles } from "./screenStyles.js";
import { KpiStrip, PageHead, relativeTime } from "./shared.js";
import type { ProjectViewModel } from "./projectViewData.js";

export interface ProjectDagBodyProps {
  projectId: string;
  projectName: string;
  dag: ProjectDag;
  model: ProjectViewModel;
}

export function ProjectDagBody(props: ProjectDagBodyProps) {
  const { dag, model } = props;
  return (
    <div class="p2b" data-project-mode="dag">
      <ScreenStyles />
      <DagStyles />
      <PageHead
        eyebrow={`▮ project · ${props.projectName} · full dag`}
        title={
          <>
            the <em>smithy</em>, top-down
          </>
        }
        actions={
          <>
            <span class="pill run">
              <span class="d"></span>
              {dag.counts.live} in flight
            </span>
            <span class="pill warn">
              <span class="d"></span>
              {dag.attention.length} need you
            </span>
            <div class="mode-toggle" data-mode-toggle data-project-id={props.projectId}>
              <a class="seg-btn" data-mode-value="chat" href={`/projects/${props.projectId}?mode=chat`}>
                鍛 forge
              </a>
              <a class="seg-btn active" data-mode-value="dag" href={`/projects/${props.projectId}?mode=dag`}>
                ↹ dag
              </a>
            </div>
            <a class="btn primary" href={`/projects/${props.projectId}/specs/new`}>
              + discover spec ↗
            </a>
          </>
        }
      />
      <KpiStrip items={model.kpis} />
      <div class="page-body">
        <div class="split-dag">
          <DagCanvas dag={dag} projectId={props.projectId} />
          <div class="col dag-rail">
            <ForgePill projectId={props.projectId} model={model} attention={dag.attention.length} />
            {model.velocity !== null && <VelocityCardCompact velocity={model.velocity} />}
            <ActivityPanel rows={model.activity} />
          </div>
        </div>
      </div>
    </div>
  );
}

function ForgePill(props: { projectId: string; model: ProjectViewModel; attention: number }) {
  return (
    <a class="forge-pill" href={`/projects/${props.projectId}?mode=chat`}>
      <div class="top">
        <span class="stamp">鍛</span>
        <span class="label">forge · collapsed</span>
        <span class="need">{props.attention} need you</span>
      </div>
      <div class="pulse">{props.model.pulseHeadline}</div>
      <div class="foot">
        <span>↑ click to expand</span>
        <span>{props.model.liveLabel}</span>
      </div>
    </a>
  );
}

function VelocityCardCompact(props: { velocity: NonNullable<ProjectViewModel["velocity"]> }) {
  const { velocity } = props;
  return (
    <div class="velocity">
      <div class="head">
        <span class="l">velocity</span>
        <span class="s">{velocity.trendLabel}</span>
      </div>
      <div class="spark" style="height:22px">
        {velocity.spark.map((h, i) => (
          <i class={i >= velocity.hotFrom ? "hot" : ""} style={`height:${Math.round(h * 0.7)}px`}></i>
        ))}
      </div>
      <div class="foot">
        <span class="k">{velocity.milestoneLabel}</span>
        <span class="v">{velocity.etaLabel}</span>
        <span class="t">{velocity.statusLabel}</span>
      </div>
    </div>
  );
}

function ActivityPanel(props: { rows: ProjectViewModel["activity"] }) {
  return (
    <div class="activity">
      <div class="panel-head">
        <h3>
          activity · <em>live</em>
        </h3>
        <span class="pill run" style="font-size:8px">
          <span class="d"></span>↻
        </span>
      </div>
      <div class="body">
        {props.rows.length === 0 ? (
          <div class="empty-note" style="padding:12px 13px">
            No recent events for this project.
          </div>
        ) : (
          props.rows.slice(0, 9).map((row) => (
            <a class="row" href={row.href}>
              <span class="ts">{relativeTime(row.ts)}</span>
              <span class={`icn ${row.kind}`}>
                {row.kind === "ok" ? "✓" : row.kind === "run" ? "↻" : row.kind === "warn" ? "!" : "▮"}
              </span>
              <div>
                <div class="ev">{row.event}</div>
                <div class="det">{row.detail}</div>
              </div>
            </a>
          ))
        )}
      </div>
    </div>
  );
}
