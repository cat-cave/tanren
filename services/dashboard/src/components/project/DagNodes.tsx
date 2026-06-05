/**
 * DAG node rects + milestone/column headers. Each node carries the
 * locked visual language: one of five status colours+glyphs, a pulsing ring for
 * live/review/blocked, a numbered attention badge, and milestone-ring headers.
 * Every node is click-routed to the spec drawer via `data-spec-id` (the
 * `dag-canvas` island reads it). No hardcoded colours — all from tokens.
 */

import type { DagStatus } from "../../api/projectDag.js";
import type { ColumnHeader, PlacedNode } from "./dagLayout.js";

interface StatusStyle {
  fill: string;
  stroke: string;
  text: string;
  glyph: string;
}

export const STATUS_STYLES: Record<DagStatus, StatusStyle> = {
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

const PULSE_COLOR: Partial<Record<DagStatus, string>> = {
  live: "var(--ember-08)",
  review: "var(--status-warn, oklch(70% 0.16 75))",
  blocked: "var(--status-fail, oklch(60% 0.18 25))",
};

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function DagColumnHeaders(props: { headers: ColumnHeader[] }) {
  return (
    <g class="dag-headers">
      {props.headers.map((h) => {
        const color =
          h.status === "live"
            ? "var(--ember-08)"
            : h.status === "review"
              ? "var(--status-warn, oklch(70% 0.16 75))"
              : h.status === "done"
                ? "var(--status-ok, oklch(58% 0.18 155))"
                : h.attention === null
                  ? "var(--fg-3)"
                  : "var(--status-warn, oklch(70% 0.16 75))";
        return (
          <g>
            {h.attention !== null && (
              <g transform={`translate(${h.cx + 44}, 18)`} class="dag-ms-badge">
                <circle
                  r="10"
                  fill="var(--status-warn, oklch(70% 0.16 75))"
                  stroke="var(--bg-canvas)"
                  stroke-width="2"
                />
                <text
                  x="0"
                  y="3.5"
                  fill="var(--accent-on)"
                  font-family="var(--font-mono)"
                  font-size="10"
                  font-weight="700"
                  text-anchor="middle"
                >
                  {h.attention}
                </text>
              </g>
            )}
            <text
              x={h.cx}
              y={40}
              fill={color}
              font-family="var(--font-mono)"
              font-size="10"
              text-anchor="middle"
              letter-spacing="0.18em"
              font-weight="700"
            >
              {truncate(h.label, 16)}
            </text>
          </g>
        );
      })}
    </g>
  );
}

export function DagNodeRect(props: { placed: PlacedNode }) {
  const { node, x, y, w, h } = props.placed;
  const s = STATUS_STYLES[node.status];
  const pulse = PULSE_COLOR[node.status];
  const label = `${s.glyph} ${truncate(node.title, 16)}`;
  return (
    <g
      class="dag-node"
      data-spec-id={node.id}
      data-status={node.status}
      transform={`translate(${x}, ${y})`}
      role="button"
      tabindex="0"
      aria-label={`${node.status} spec ${node.title}`}
    >
      {pulse !== undefined && (
        <rect
          class="dag-pulse"
          x="-2"
          y="-2"
          width={w + 4}
          height={h + 4}
          rx="3"
          fill="none"
          stroke={pulse}
          stroke-width="1.5"
          opacity="0.6"
        >
          <animate attributeName="opacity" values="0.6;0;0.6" dur="1.6s" repeatCount="indefinite" />
          <animate attributeName="stroke-width" values="1.5;3;1.5" dur="1.6s" repeatCount="indefinite" />
        </rect>
      )}
      <rect width={w} height={h} rx="2" fill={s.fill} stroke={s.stroke} stroke-width={pulse === undefined ? 1 : 1.5} />
      {node.onCriticalPath && <rect x="0" y="0" width="3" height={h} fill="var(--ember-08)" />}
      <text x={9} y={17} fill={s.text} font-family="var(--font-mono)" font-size="10">
        {label}
      </text>
      {node.attention !== null && (
        <g transform={`translate(${w - 5}, -3)`} class="dag-attn-badge">
          <circle r="9" fill="var(--ember-08)" stroke="var(--bg-canvas)" stroke-width="2" />
          <text
            x="0"
            y="3.5"
            fill="var(--accent-on)"
            font-family="var(--font-mono)"
            font-size="10"
            font-weight="700"
            text-anchor="middle"
          >
            {node.attention}
          </text>
        </g>
      )}
    </g>
  );
}

export function DagNodes(props: { nodes: PlacedNode[] }) {
  return (
    <g class="dag-nodes">
      {props.nodes.map((placed) => (
        <DagNodeRect placed={placed} />
      ))}
    </g>
  );
}
