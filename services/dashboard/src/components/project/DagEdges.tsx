/**
 * DAG dependency edges. Straight hot/cool lines between node centres
 * with arrow markers, matching the hi-fi `bparr-hot` / `bparr-cool` markers.
 * Cool edges use `--line-2`; hot edges (touching a node that needs action) use
 * `--ember-08`. No hardcoded colours.
 */

import type { PlacedEdge } from "./dagLayout.js";

export function DagEdgeDefs() {
  return (
    <defs>
      <marker id="dag-arr-cool" markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto">
        <path d="M0,0 L6,3 L0,6" fill="var(--line-2)" />
      </marker>
      <marker id="dag-arr-hot" markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto">
        <path d="M0,0 L6,3 L0,6" fill="var(--ember-08)" />
      </marker>
    </defs>
  );
}

export function DagEdges(props: { edges: PlacedEdge[] }) {
  return (
    <g class="dag-edges">
      {props.edges.map((edge) => (
        <line
          x1={edge.x1}
          y1={edge.y1}
          x2={edge.x2}
          y2={edge.y2}
          stroke={edge.hot ? "var(--ember-08)" : "var(--line-2)"}
          stroke-width={edge.hot ? 1.5 : 1}
          marker-end={edge.hot ? "url(#dag-arr-hot)" : "url(#dag-arr-cool)"}
        />
      ))}
    </g>
  );
}
