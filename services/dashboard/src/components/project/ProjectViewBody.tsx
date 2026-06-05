/**
 * Chat-primary project view body. The operator home: a Forge
 * narration card (pulse + ranked attention queue + suboptimal callouts +
 * suggested prompts + composer) on the left, and a DAG snapshot + velocity +
 * activity feed on the right. DAG-primary mode is a documented later
 * placeholder. Every number is data-derived (see `projectViewData.ts`); the
 * subopt callouts render real insights only.
 */

import type { InsightSummary } from "../../api/types.js";
import { ScreenStyles } from "./screenStyles.js";
import { KpiStrip, PageHead, relativeTime } from "./shared.js";
import type { ActivityRow, AttentionEntry, DagNode, ProjectViewModel, VelocityModel } from "./projectViewData.js";

export interface ProjectViewBodyProps {
  projectId: string;
  projectName: string;
  orgId: string | undefined;
  model: ProjectViewModel;
  insights: InsightSummary[];
}

export function ProjectViewBody(props: ProjectViewBodyProps) {
  const { model } = props;
  return (
    <div class="p2b">
      <ScreenStyles />
      <PageHead
        eyebrow={`▮ project · ${props.projectName}`}
        title={
          <>
            what needs <em>your attention</em>?
          </>
        }
        actions={
          <>
            <span class="pill run">
              <span class="d"></span>
              {model.liveLabel}
            </span>
            <div class="mode-toggle" data-mode-toggle data-project-id={props.projectId}>
              <a class="seg-btn active" data-mode-value="chat" href={`/projects/${props.projectId}?mode=chat`}>
                鍛 forge
              </a>
              <a class="seg-btn" data-mode-value="dag" href={`/projects/${props.projectId}?mode=dag`}>
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
        <div class="split-chat">
          <ForgeNarrationCard {...props} />
          <div class="col">
            <DagSnapshot nodes={model.dagNodes} />
            {model.velocity !== null && <VelocityCard velocity={model.velocity} />}
            <ActivityFeed rows={model.activity} />
          </div>
        </div>
      </div>
    </div>
  );
}

function ForgeNarrationCard(props: ProjectViewBodyProps) {
  const { model, insights } = props;
  return (
    <div class="forge-card">
      <div class="head">
        <span class="stamp">鍛</span>
        <span class="title">
          forge · <em>your attention queue</em>
        </span>
        <span class="meta">{model.liveLabel}</span>
      </div>
      <div class="body">
        {/* 1. STATE: one-sentence pulse */}
        <div class="forge-turn">
          <div class="state-card">
            <div class="label">▮ project pulse</div>
            <div class="text">{model.pulseHeadline}</div>
            <div class="sub-text">{model.pulseSub}</div>
          </div>
        </div>

        {/* 2. ATTENTION QUEUE: ranked things-that-need-you */}
        <div class="forge-turn">
          <div class="turn-label">▮ {model.attention.length} things need you · ranked</div>
          {model.attention.length === 0 ? (
            <div class="empty-note">
              Nothing needs you right now. Forge will surface review handoffs and open runs here.
            </div>
          ) : (
            <div class="col" style="gap:6px">
              {model.attention.map((entry) => (
                <AttentionRow entry={entry} />
              ))}
            </div>
          )}
        </div>

        {/* 3. SUBOPTIMAL CALLOUTS: real insights only */}
        {insights.length > 0 && (
          <div class="forge-turn">
            <div class="turn-label">▮ {insights.length} workflow callouts</div>
            <div class="col" style="gap:8px">
              {insights.map((insight) => (
                <SuboptCallout insight={insight} orgId={props.orgId} projectId={props.projectId} />
              ))}
            </div>
          </div>
        )}

        {/* 4. PROMPTS: suggested follow-ups (placeholder composer) */}
        <div class="forge-turn">
          <div class="turn-label">▮ ask anything</div>
          <div class="chips">
            {model.prompts.map((prompt) => (
              <span class="chip">
                <span class="pre">↑</span>
                {prompt}
              </span>
            ))}
          </div>
        </div>
      </div>
      <form class="forge-input" method="get" action={`/projects/${props.projectId}`}>
        <span class="stamp">鍛</span>
        <input name="ask" placeholder="type · thick forge composer ships in phase 3" disabled />
        <span class="kbd">↵</span>
      </form>
    </div>
  );
}

function AttentionRow(props: { entry: AttentionEntry }) {
  const { entry } = props;
  const cls = `attn-row${entry.tone ? ` ${entry.tone}` : ""}`;
  const inner = (
    <>
      <span class="priority">{entry.priority}</span>
      <div>
        <div class="t">{entry.title}</div>
        <div class="s">{entry.sub}</div>
      </div>
      <span class="arrow">↗</span>
    </>
  );
  if (entry.href === null) {
    return <div class={cls}>{inner}</div>;
  }
  return (
    <a class={cls} href={entry.href}>
      {inner}
    </a>
  );
}

/**
 * A suboptimal callout — a rendered insight with operator-button actions. Each
 * action POSTs the carried Forge tool call through the dashboard's `/forge/tools`
 * proxy (which forwards to). Buttons only appear for declared tools.
 */
function SuboptCallout(props: { insight: InsightSummary; orgId: string | undefined; projectId: string }) {
  const { insight } = props;
  return (
    <div class="subopt">
      <div class="kind">{insight.kind.replaceAll("_", " ")}</div>
      <div class="t">{insight.title}</div>
      <div class="b">{insight.body}</div>
      {insight.actions.length > 0 && props.orgId !== undefined && (
        <div class="acts">
          {insight.actions.map((action) => (
            <form method="post" action={`/projects/${props.projectId}/insights/act`}>
              <input type="hidden" name="orgId" value={props.orgId} />
              <input type="hidden" name="tool" value={action.toolCall.tool} />
              <input type="hidden" name="args" value={JSON.stringify(action.toolCall.args ?? {})} />
              <button type="submit">{action.label}</button>
            </form>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Read-only DAG snapshot. Lays recent runs out as status-colored nodes in a
 * simple grid (the full spec-graph layout is the later DAG-primary mode). Node click
 * routes per the hi-fi rule: live/done/review → run detail; blocked/queued →
 * no-op.
 */
function DagSnapshot(props: { nodes: DagNode[] }) {
  const cols = 4;
  const cellW = 250;
  const cellH = 56;
  const width = cols * cellW;
  const rows = Math.max(1, Math.ceil(props.nodes.length / cols));
  const height = rows * cellH + 16;
  return (
    <div class="dag-shell">
      <div class="dag-head">
        <span class="pill run">
          <span class="d"></span>dag · live
        </span>
        <span class="note">{props.nodes.length} nodes · click any node</span>
      </div>
      <div class="dag-canvas">
        {props.nodes.length === 0 ? (
          <div class="empty-note">No runs yet — the DAG snapshot renders nodes once a spec runs.</div>
        ) : (
          <svg
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label="project dag snapshot"
          >
            {props.nodes.map((node, index) => (
              <DagNodeRect
                node={node}
                x={(index % cols) * cellW + 8}
                y={Math.floor(index / cols) * cellH + 8}
                w={cellW - 16}
              />
            ))}
          </svg>
        )}
      </div>
      <div class="dag-placeholder">dag-primary mode (full canvas + group-by) → Phase 3</div>
    </div>
  );
}

const DAG_COLORS: Record<DagNode["status"], { fill: string; stroke: string; text: string; glyph: string }> = {
  done: {
    fill: "oklch(58% 0.18 155 / 0.14)",
    stroke: "var(--status-ok, oklch(58% 0.18 155))",
    text: "var(--fg-2)",
    glyph: "✓",
  },
  live: {
    fill: "var(--accent-tint)",
    stroke: "var(--ember-08)",
    text: "var(--ember-08)",
    glyph: "↻",
  },
  review: {
    fill: "oklch(70% 0.16 75 / 0.22)",
    stroke: "var(--status-warn, oklch(70% 0.16 75))",
    text: "var(--status-warn, oklch(70% 0.16 75))",
    glyph: "!",
  },
  blocked: {
    fill: "oklch(60% 0.18 25 / 0.14)",
    stroke: "var(--status-fail, oklch(60% 0.18 25))",
    text: "var(--status-fail, oklch(60% 0.18 25))",
    glyph: "⏳",
  },
  queued: { fill: "var(--bg-canvas)", stroke: "var(--line-2)", text: "var(--fg-3)", glyph: "○" },
};

function DagNodeRect(props: { node: DagNode; x: number; y: number; w: number }) {
  const { node } = props;
  const c = DAG_COLORS[node.status];
  const label = `${c.glyph} ${node.milestone} · ${truncate(node.title, 26)}`;
  const rect = (
    <g
      class="dag-node"
      transform={`translate(${props.x}, ${props.y})`}
      style={node.href === null ? "cursor:default" : "cursor:pointer"}
    >
      <rect width={props.w} height="34" rx="3" fill={c.fill} stroke={c.stroke} stroke-width="1" />
      <text x="9" y="21" fill={c.text} font-family="var(--font-mono)" font-size="11">
        {label}
      </text>
    </g>
  );
  if (node.href === null) return rect;
  return <a href={node.href}>{rect}</a>;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function VelocityCard(props: { velocity: VelocityModel }) {
  const { velocity } = props;
  return (
    <div class="velocity">
      <div class="head">
        <span class="l">velocity</span>
        <span class="s">{velocity.trendLabel}</span>
      </div>
      <div class="spark">
        {velocity.spark.map((h, i) => (
          <i class={i >= velocity.hotFrom ? "hot" : ""} style={`height:${h}px`}></i>
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

function ActivityFeed(props: { rows: ActivityRow[] }) {
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
          props.rows.map((row) => (
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
