/**
 * The DAG-primary canvas shell (P3-0013): the "N need you" strip, the spec/
 * behavior/critical-path count line, group-by + fit/zoom controls, the SVG
 * canvas (headers + edges + nodes), and the bottom-left legend.
 *
 * The SVG is server-rendered for the default group-by (`milestone`); the
 * `dag-canvas` island re-lays-out the graph client-side when group-by/zoom
 * change and routes node clicks to the spec drawer. The serialized model is
 * embedded as JSON so the island never re-fetches.
 */

import type { ProjectDag } from "../../api/projectDag.js";
import { layoutDag, type GroupBy } from "./dagLayout.js";
import { DagColumnHeaders, DagNodes } from "./DagNodes.js";
import { DagEdgeDefs, DagEdges } from "./DagEdges.js";
import { DagLegend } from "./DagLegend.js";

const GROUPS: GroupBy[] = ["milestone", "behavior", "priority"];

function NeedsStrip(props: { dag: ProjectDag; projectId: string }) {
  if (props.dag.attention.length === 0) {
    return (
      <div class="needs-strip empty">
        <span class="needs-label">▮ nothing needs you</span>
        <span class="needs-quiet">forge will surface review handoffs + blocks here</span>
      </div>
    );
  }
  return (
    <div class="needs-strip">
      <span class="needs-label">▮ {props.dag.attention.length} need you</span>
      {props.dag.attention.slice(0, 4).map((item) => (
        <button type="button" class={`needs-item kind-${item.kind}`} data-spec-id={item.nodeId}>
          <span class={`badge-num kind-${item.kind}`}>{item.n}</span>
          <span class="needs-text">
            <span class="t">{item.title}</span>
            <span class="s">{item.sub}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

export function DagCanvas(props: { dag: ProjectDag; projectId: string }) {
  const { dag } = props;
  const layout = layoutDag(dag, "milestone");
  const c = dag.counts;
  return (
    <div
      class="dag-shell dag-primary"
      data-island="dag-canvas"
      data-project-id={props.projectId}
      data-dag={JSON.stringify(dag)}
    >
      <div class="grid-bg"></div>
      <NeedsStrip dag={dag} projectId={props.projectId} />
      <div class="dag-head">
        <span class="pill cold">
          <span class="d"></span>
          {c.total} specs · {c.done} done · {c.live} live · {c.criticalPath} critical-path
        </span>
        <span class="pill ok">
          <span class="d"></span>
          tied to {c.behaviors} behaviors
        </span>
        <div class="dag-controls">
          <span class="ctl-label">group by</span>
          {GROUPS.map((g) => (
            <button type="button" class={`seg-btn${g === "milestone" ? " active" : ""}`} data-group={g}>
              {g}
            </button>
          ))}
          <span class="ctl-sep">·</span>
          <button type="button" class="seg-btn" data-zoom="fit">
            fit
          </button>
          <button type="button" class="seg-btn" data-zoom="in">
            +
          </button>
          <button type="button" class="seg-btn" data-zoom="out">
            −
          </button>
        </div>
      </div>
      <div class="dag-canvas" data-dag-canvas>
        {dag.nodes.length === 0 ? (
          <div class="empty-note dag-fresh">
            Fresh DAG — no specs yet. Discover a spec and Forge starts laying out the graph.
          </div>
        ) : (
          <svg
            data-dag-svg
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label="project spec dag"
          >
            <DagEdgeDefs />
            <g data-dag-pan>
              <DagColumnHeaders headers={layout.headers} />
              <DagEdges edges={layout.edges} />
              <DagNodes nodes={layout.nodes} />
            </g>
          </svg>
        )}
      </div>
      <DagLegend />
      <div class="dag-hint">↑ click any node · pulsing = needs action · → opens spec</div>
    </div>
  );
}
