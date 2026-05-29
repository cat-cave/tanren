/**
 * Pure SVG layout for the DAG-primary canvas (P3-0013). Takes the assembled
 * `ProjectDag` plus a group-by mode and produces absolute node rectangles +
 * edge line segments in a fixed viewBox, so the rendering components
 * (`DagNodes`/`DagEdges`) stay dumb and the layout is unit-testable.
 *
 * Layout is a banded column grid: each group (milestone / behavior / priority)
 * is a vertical column, specs stack down the column. Edges are straight lines
 * between node centres with a hot/cool flag carried from the model. This is a
 * faithful, deterministic stand-in for the hi-fi hand-placed graph — it reads
 * as the same "smithy top-down" canvas while being driven entirely by data.
 */

import type { DagNode, DagStatus, ProjectDag } from "../../api/dagTypes.js";

export type GroupBy = "milestone" | "behavior" | "priority";

export const NODE_W = 132;
export const NODE_H = 26;
const COL_GAP = 52;
const ROW_GAP = 16;
const COL_W = NODE_W + COL_GAP;
const HEADER_Y = 56;
const TOP_PAD = HEADER_Y + 18;
const SIDE_PAD = 24;

export interface PlacedNode {
  node: DagNode;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlacedEdge {
  from: string;
  to: string;
  hot: boolean;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface ColumnHeader {
  key: string;
  label: string;
  x: number;
  /** Centre x of the column (badge + title anchor). */
  cx: number;
  status: DagStatus | "neutral";
  attention: number | null;
}

export interface DagLayout {
  width: number;
  height: number;
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  headers: ColumnHeader[];
}

const PRIORITY_ORDER: DagStatus[] = ["review", "blocked", "live", "queued", "done"];

function groupKey(node: DagNode, group: GroupBy): { key: string; label: string } {
  if (group === "priority") return { key: node.priority, label: node.priority };
  if (group === "behavior") {
    const b = node.behaviors[0];
    return b !== undefined ? { key: `b:${b}`, label: b } : { key: "b:—", label: "no behavior" };
  }
  return node.milestoneId !== null
    ? { key: node.milestoneId, label: node.milestone }
    : { key: "m:—", label: "unlinked" };
}

/** Order columns: priority by severity, milestone/behavior by first appearance. */
function orderColumns(group: GroupBy, keys: string[]): string[] {
  if (group !== "priority") return keys;
  return [...keys].sort((a, b) => PRIORITY_ORDER.indexOf(a as DagStatus) - PRIORITY_ORDER.indexOf(b as DagStatus));
}

function headerStatus(group: GroupBy, members: DagNode[]): DagStatus | "neutral" {
  if (group !== "priority") {
    if (members.some((m) => m.status === "live")) return "live";
    if (members.some((m) => m.status === "review")) return "review";
    if (members.every((m) => m.status === "done") && members.length > 0) return "done";
    return "neutral";
  }
  return (members[0]?.status as DagStatus) ?? "neutral";
}

export function layoutDag(dag: ProjectDag, group: GroupBy): DagLayout {
  // Bucket nodes by group key, preserving model order within a bucket.
  const buckets = new Map<string, { label: string; nodes: DagNode[] }>();
  for (const node of dag.nodes) {
    const { key, label } = groupKey(node, group);
    const bucket = buckets.get(key) ?? { label, nodes: [] };
    bucket.nodes.push(node);
    buckets.set(key, bucket);
  }

  const keys = orderColumns(group, [...buckets.keys()]);
  const headers: ColumnHeader[] = [];
  const placed: PlacedNode[] = [];
  const pos = new Map<string, PlacedNode>();
  let maxRows = 0;

  keys.forEach((key, colIndex) => {
    const bucket = buckets.get(key);
    if (bucket === undefined) return;
    const x = SIDE_PAD + colIndex * COL_W;
    const cx = x + NODE_W / 2;
    headers.push({
      key,
      label: bucket.label,
      x,
      cx,
      status: headerStatus(group, bucket.nodes),
      attention: bucket.nodes.find((n) => n.attention !== null)?.attention ?? null
    });
    bucket.nodes.forEach((node, rowIndex) => {
      const y = TOP_PAD + rowIndex * (NODE_H + ROW_GAP);
      const p: PlacedNode = { node, x, y, w: NODE_W, h: NODE_H };
      placed.push(p);
      pos.set(node.id, p);
    });
    maxRows = Math.max(maxRows, bucket.nodes.length);
  });

  const edges: PlacedEdge[] = [];
  for (const edge of dag.edges) {
    const a = pos.get(edge.from);
    const b = pos.get(edge.to);
    if (a === undefined || b === undefined) continue;
    edges.push({
      from: edge.from,
      to: edge.to,
      hot: edge.hot,
      x1: a.x + a.w / 2,
      y1: a.y + a.h / 2,
      x2: b.x + b.w / 2,
      y2: b.y + b.h / 2
    });
  }

  const width = Math.max(COL_W, SIDE_PAD * 2 + keys.length * COL_W - COL_GAP);
  const height = Math.max(200, TOP_PAD + maxRows * (NODE_H + ROW_GAP) + 24);
  return { width, height, nodes: placed, edges, headers };
}
