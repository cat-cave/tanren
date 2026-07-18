// bh-14b — the org-scoped self-healing funnel read surface. Aggregates ALL of the
// org's issue loops (across every project) with their latest sealed-proof badges
// into the reproduce → fix → merge → deploy → symptom-verify → source-close funnel.
// Read-only: there is NO write/seal endpoint here — sealing stays internal to the
// ResolutionAuthority / source-sync worker (bh-14a).
//
// Mounted at "/v1/orgs":
//   GET /v1/orgs/:orgId/self-healing/funnel
//
// Runs on the org-scoping pool under the request's org GUC, so RLS denies every
// other tenant's loops by default — a cross-org caller sees zero rows.

import { runWithOrgScope } from "@tanren/db";
import { Hono, type Context } from "hono";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import {
  computeSelfHealingFunnel,
  type SelfHealingBadges,
  type SelfHealingLoopInput,
} from "../../engine/governance/selfHealingFunnel.js";
import { ISSUE_LOOP_STATES, type IssueLoopState } from "../../engine/repositories/issueLoops.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/access.js";

export interface SelfHealingRoutesOptions {
  readonly pool: pg.Pool;
}

type RouteContext = Context<ActorContextEnv>;
type Row = Record<string, unknown>;

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const ISSUE_LOOP_STATE_SET = new Set<string>(ISSUE_LOOP_STATES);

const FUNNEL_SQL = `
  SELECT loop.id,
         loop.project_id,
         loop.state,
         loop.severity,
         loop.fingerprint,
         proof.terminal,
         proof.proof_json -> 'badges' AS badges
    FROM issue_loops AS loop
    LEFT JOIN LATERAL (
      SELECT p.terminal, p.proof_json
        FROM resolution_proofs AS p
       WHERE p.org_id = loop.org_id AND p.issue_loop_id = loop.id
       ORDER BY (p.terminal = 'authorized_verified_closed') DESC, p.created_at DESC, p.id DESC
       LIMIT 1
    ) AS proof ON TRUE
   WHERE loop.org_id = $1
   ORDER BY loop.created_at DESC, loop.id DESC
   LIMIT $2`;

function requireActor(c: RouteContext): ActorContext {
  if (c.var.actor === undefined) throw new Error("actor missing on context");
  return c.var.actor;
}

function requireParam(c: RouteContext, name: string): string {
  const value = c.req.param(name);
  if (value === undefined || value === "") throw new Error(`route parameter ${name} missing`);
  return value;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function decodeState(value: unknown): IssueLoopState {
  const state = text(value);
  if (!ISSUE_LOOP_STATE_SET.has(state)) throw new Error(`unknown issue loop state ${state}`);
  return state as IssueLoopState;
}

/** Read the stored badge object, keeping the six fields as opaque strings. */
function decodeBadges(value: unknown): SelfHealingBadges | null {
  if (value === null || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  return {
    gate: text(raw["gate"]),
    merged: text(raw["merged"]),
    deploy: text(raw["deploy"]),
    demo: text(raw["demo"]),
    symptom: text(raw["symptom"]),
    source: text(raw["source"]),
  };
}

function decodeLoop(row: Row): SelfHealingLoopInput {
  return {
    loopId: text(row["id"]),
    projectId: text(row["project_id"]),
    state: decodeState(row["state"]),
    severity: text(row["severity"]),
    fingerprint: text(row["fingerprint"]),
    terminal: typeof row["terminal"] === "string" ? row["terminal"] : null,
    badges: decodeBadges(row["badges"]),
  };
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return undefined;
  return Math.min(parsed, MAX_LIMIT);
}

export function createSelfHealingRoutes(options: SelfHealingRoutesOptions) {
  const app = new Hono<ActorContextEnv>();

  app.get("/:orgId/self-healing/funnel", async (c) => {
    const actor = requireActor(c);
    const orgId = requireParam(c, "orgId");
    if (!actorCanAccessOrg(actor, orgId)) return c.json({ error: "org_access_denied" }, 403);
    const limit = parseLimit(c.req.query("limit")) ?? DEFAULT_LIMIT;
    const rows = await runWithOrgScope(options.pool, orgId, (client) => client.query<Row>(FUNNEL_SQL, [orgId, limit]));
    const funnel = computeSelfHealingFunnel(rows.rows.map(decodeLoop));
    return c.json({ version: "v1" as const, orgId, funnel });
  });

  return app;
}
