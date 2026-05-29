// P3-0020 `stuck` compute. Derives from the P2A-0018 spec-dependency graph
// (`spec_dependencies` directed edges: `from_spec_id` depends on
// `to_spec_id`). A spec is "stuck" when it is itself not yet finished and at
// least one of its declared dependencies is not finished either, so the chain
// cannot progress.
//
// "Finished" means a terminal-good or abandoned status — `merged`, `done`, or
// `cancelled`. Anything else (`open`, `pending`, `active`, `in_flight`,
// `review`, `halted`) is unfinished. `chainDepth` is the count of distinct
// unfinished specs reachable from the blocked spec through dependency edges,
// so a long unfinished chain reads as a deeper block than a single missing
// dependency.
//
// Reported from existing rows only — no migration to the source data (the
// only schema change in P3-0020 is widening the `workflow_insights.kind`
// cache CHECK; see `db/src/schemaInsights.ts`).

import type pg from "pg";
import { randomUUID } from "node:crypto";
import { type ComputeContext } from "./retryHotspot.js";
import { type Insight, type StuckPayload } from "./types.js";

const FINISHED_STATUSES = new Set(["merged", "done", "cancelled"]);

interface EdgeRow {
  from_spec_id: string;
  from_title: string;
  from_status: string;
  to_spec_id: string;
  to_title: string;
  to_status: string;
}

export async function computeStuck(pool: Pick<pg.Pool, "query">, context: ComputeContext): Promise<Insight[]> {
  const now = context.now ?? new Date();

  // Pull every dependency edge in the project, carrying both endpoints'
  // status/title so the chain analysis is a single round trip.
  const edgesResult = await pool.query<EdgeRow>(
    `SELECT d.from_spec_id,
            fs.title  AS from_title,
            fs.status AS from_status,
            d.to_spec_id,
            ts.title  AS to_title,
            ts.status AS to_status
       FROM spec_dependencies d
       INNER JOIN specs fs ON fs.spec_id = d.from_spec_id
       INNER JOIN specs ts ON ts.spec_id = d.to_spec_id
       WHERE fs.project_id = $1`,
    [context.projectId],
  );
  if (edgesResult.rows.length === 0) return [];

  // Build the dependency adjacency (from -> [to]) plus a status/title lookup.
  const deps = new Map<string, string[]>();
  const status = new Map<string, string>();
  const title = new Map<string, string>();
  for (const row of edgesResult.rows) {
    status.set(row.from_spec_id, row.from_status);
    status.set(row.to_spec_id, row.to_status);
    title.set(row.from_spec_id, row.from_title);
    title.set(row.to_spec_id, row.to_title);
    const list = deps.get(row.from_spec_id) ?? [];
    list.push(row.to_spec_id);
    deps.set(row.from_spec_id, list);
  }

  const insights: Insight[] = [];
  for (const [specId, directDeps] of deps) {
    if (FINISHED_STATUSES.has(status.get(specId) ?? "")) continue;
    const blocking = directDeps
      .filter((dep) => !FINISHED_STATUSES.has(status.get(dep) ?? ""))
      .map((dep) => ({
        specId: dep,
        title: title.get(dep) ?? dep,
        status: status.get(dep) ?? "unknown",
      }));
    if (blocking.length === 0) continue;

    const chainDepth = countUnfinishedChain(specId, deps, status);
    const payload: StuckPayload = {
      kind: "stuck",
      blockedSpecId: specId,
      blockedSpecTitle: title.get(specId) ?? specId,
      blockingSpecs: blocking,
      chainDepth,
    };
    const insightId = `insight_stuck_${specId}_${randomUUID()}`;
    const blockerNames = blocking.map((b) => b.title).join(", ");
    insights.push({
      id: insightId,
      kind: "stuck",
      projectId: context.projectId,
      severity: chainDepth >= 3 ? "warn" : "info",
      title: `${payload.blockedSpecTitle} blocked on ${blocking.length} dependenc${blocking.length === 1 ? "y" : "ies"}`,
      body: `${payload.blockedSpecTitle} cannot progress until upstream work lands: ${blockerNames}. ${chainDepth} spec${chainDepth === 1 ? "" : "s"} in this chain are unfinished.`,
      payload,
      actions: [
        {
          label: "Open blocked spec",
          toolCall: { tool: "tanren.read_run", args: { specId } },
        },
        {
          label: "Acknowledge",
          toolCall: { tool: "tanren.acknowledge_insight", args: { insightId } },
        },
      ],
      computedAt: now,
      acknowledgedAt: null,
      acknowledgedBy: null,
    });
  }
  return insights;
}

// Count distinct unfinished specs reachable from `start` through dependency
// edges, including `start` itself. Cycle-safe via a visited set; the
// no-self-loop CHECK plus the visited guard keep this bounded.
function countUnfinishedChain(start: string, deps: Map<string, string[]>, status: Map<string, string>): number {
  const visited = new Set<string>();
  const stack = [start];
  let count = 0;
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined || visited.has(node)) continue;
    visited.add(node);
    if (!FINISHED_STATUSES.has(status.get(node) ?? "")) count += 1;
    for (const next of deps.get(node) ?? []) {
      if (!visited.has(next)) stack.push(next);
    }
  }
  return count;
}
