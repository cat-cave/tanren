// In-memory `pg`-shaped backing store for the forge/recovery `Repositories`
// conformance suite (forgeRecoveryRepositories.conformance.test.ts). Mirrors the
// product-entity harness (conformanceMemoryDb.ts + repositories.conformance.test.ts):
// a shared record store plus a per-org ScopedClient that models RLS row
// visibility — a client scoped to org X (one that carried `SET LOCAL
// app.current_org_id = 'X'`) sees ONLY org X's rows, so an off-scope read sees
// ZERO of another org's rows. The stores emit the same SQL against the real pg
// impl; this fake recognizes exactly those statements (whitespace-collapsed) and
// applies the org filter, so the conformance assertions hold over both the
// in-memory fake and the real org-scoped transaction.

import type { QueryClient } from "../../src/engine/contracts/repositories.js";
import {
  auditCols,
  type AuditJobRec,
  type EventRec,
  type ForgeRecoveryDb,
  type InboxSourceRec,
  type ProjectRec,
  type QueryResult,
  type RunRec,
  type SpecRec,
} from "./forgeRecoveryRecords.js";

export { ForgeRecoveryDb } from "./forgeRecoveryRecords.js";
export type { QueryResult } from "./forgeRecoveryRecords.js";

const NOW = new Date("2026-03-01T00:00:00.000Z");

// A `pg`-shaped client bound to one org scope; reads filter rows whose org_id is
// not this scope (and the project-less projects rows stay visible only to their
// own org). Writes mutate the shared store but only for rows visible to this
// scope, so an off-scope UPDATE matches zero rows — the RLS write contract.
export class ForgeRecoveryScopedClient {
  constructor(
    private readonly db: ForgeRecoveryDb,
    private readonly orgId: string,
  ) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async query(rawSql: string, params: readonly unknown[] = []): Promise<QueryResult> {
    const sql = rawSql.replaceAll(/\s+/gu, " ").trim();
    const result = this.dispatch(sql, params);
    if (result === undefined) {
      throw new Error(`ForgeRecoveryDb: unrecognized SQL: ${sql}`);
    }
    return result;
  }

  private get visibleSpecs(): SpecRec[] {
    return this.db.specs.filter((r) => r.org_id === this.orgId);
  }
  private get visibleRuns(): RunRec[] {
    return this.db.runs.filter((r) => r.org_id === this.orgId);
  }
  private get visibleEvents(): EventRec[] {
    return this.db.events.filter((r) => r.org_id === this.orgId);
  }
  private get visibleProjects(): ProjectRec[] {
    return this.db.projects.filter((r) => r.org_id === this.orgId);
  }

  private dispatch(sql: string, params: readonly unknown[]): QueryResult | undefined {
    return (
      this.discoverySql(sql, params) ??
      this.recoverySql(sql, params) ??
      this.toolsSql(sql, params) ??
      this.inboxSql(sql, params) ??
      this.auditSql(sql, params)
    );
  }

  private discoverySql(sql: string, params: readonly unknown[]): QueryResult | undefined {
    if (sql === "SELECT metadata FROM specs WHERE spec_id = $1") {
      const row = this.visibleSpecs.find((s) => s.spec_id === params[0]);
      return row === undefined ? { rows: [], rowCount: 0 } : { rows: [{ metadata: row.metadata }], rowCount: 1 };
    }
    if (sql === "UPDATE specs SET metadata = $2::jsonb WHERE spec_id = $1 RETURNING spec_id") {
      const row = this.visibleSpecs.find((s) => s.spec_id === params[0]);
      if (row !== undefined) row.metadata = JSON.parse(params[1] as string);
      return { rows: row ? [{ spec_id: row.spec_id }] : [], rowCount: row ? 1 : 0 };
    }
    if (
      sql ===
      "SELECT spec_id, title, status FROM specs WHERE project_id = $1 ORDER BY (status IN ('open','in_flight','review','needs_attention')) DESC, created_at DESC LIMIT $2"
    ) {
      // Mirror the bounded grounding query (§7.5): active (non-terminal) specs first,
      // then by recency, capped at the LIMIT param. The fixture's array index is the
      // recency proxy when a row carries no explicit created_at.
      const active = new Set(["open", "in_flight", "review", "needs_attention"]);
      const limit = params[1] as number;
      const recency = (s: SpecRec): number => s.created_at ?? this.db.specs.indexOf(s);
      const rows = this.visibleSpecs
        .filter((s) => s.project_id === params[0])
        .sort((a, b) => {
          const activeDelta = Number(active.has(b.status)) - Number(active.has(a.status));
          return activeDelta === 0 ? recency(b) - recency(a) : activeDelta;
        })
        .slice(0, limit)
        .map((s) => ({ spec_id: s.spec_id, title: s.title, status: s.status }));
      return { rows, rowCount: rows.length };
    }
    return undefined;
  }

  private recoverySql(sql: string, params: readonly unknown[]): QueryResult | undefined {
    if (sql === "SELECT spec_id, project_id, status, outcome FROM runs WHERE run_id = $1") {
      const r = this.visibleRuns.find((x) => x.run_id === params[0]);
      return r === undefined
        ? { rows: [], rowCount: 0 }
        : {
            rows: [{ spec_id: r.spec_id, project_id: r.project_id, status: r.status, outcome: r.outcome }],
            rowCount: 1,
          };
    }
    if (
      /^SELECT payload FROM events WHERE run_id = \$1 AND event_type = 'workspace\.git_captured' ORDER BY ts DESC, id DESC LIMIT 1$/u.test(
        sql,
      )
    ) {
      const rows = this.capturedEvents(params[0] as string);
      return rows.length === 0 ? { rows: [], rowCount: 0 } : { rows: [{ payload: rows[0]!.payload }], rowCount: 1 };
    }
    if (
      /^SELECT payload FROM events WHERE run_id = \$1 AND event_type = 'workspace\.git_captured' ORDER BY ts DESC, id DESC$/u.test(
        sql,
      )
    ) {
      const rows = this.capturedEvents(params[0] as string).map((e) => ({ payload: e.payload }));
      return { rows, rowCount: rows.length };
    }
    if (/^UPDATE specs SET description = description \|\| .* \|\| \$2 WHERE spec_id = \$1$/u.test(sql)) {
      const row = this.visibleSpecs.find((s) => s.spec_id === params[0]);
      if (row !== undefined) row.description = `${row.description}\n\n[operator steering] ${params[1] as string}`;
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (sql === "UPDATE specs SET status = 'open' WHERE spec_id = $1 AND status <> 'merged'") {
      const row = this.visibleSpecs.find((s) => s.spec_id === params[0] && s.status !== "merged");
      if (row !== undefined) row.status = "open";
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    return undefined;
  }

  private capturedEvents(runId: string): EventRec[] {
    return this.visibleEvents
      .filter((e) => e.run_id === runId && e.event_type === "workspace.git_captured")
      .sort((a, b) => b.ts.getTime() - a.ts.getTime() || b.id - a.id);
  }

  private toolsSql(sql: string, params: readonly unknown[]): QueryResult | undefined {
    if (sql === "SELECT org_id FROM projects WHERE project_id = $1") {
      const p = this.visibleProjects.find((x) => x.project_id === params[0]);
      return p === undefined ? { rows: [], rowCount: 0 } : { rows: [{ org_id: p.org_id }], rowCount: 1 };
    }
    if (sql === "SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2") {
      const rows = this.db.members.filter(
        (m) => m.org_id === this.orgId && m.project_id === params[0] && m.user_id === params[1],
      );
      return { rows: rows.map((m) => ({ role: m.role })), rowCount: rows.length };
    }
    if (sql === "SELECT project_id, spec_id FROM runs WHERE run_id = $1") {
      const r = this.visibleRuns.find((x) => x.run_id === params[0]);
      return r === undefined
        ? { rows: [], rowCount: 0 }
        : { rows: [{ project_id: r.project_id, spec_id: r.spec_id }], rowCount: 1 };
    }
    if (sql === "SELECT project_id FROM specs WHERE spec_id = $1") {
      const s = this.visibleSpecs.find((x) => x.spec_id === params[0]);
      return s === undefined ? { rows: [], rowCount: 0 } : { rows: [{ project_id: s.project_id }], rowCount: 1 };
    }
    if (sql === "SELECT * FROM specs WHERE spec_id = $1") {
      const s = this.visibleSpecs.find((x) => x.spec_id === params[0]);
      return s === undefined ? { rows: [], rowCount: 0 } : { rows: [{ ...s }], rowCount: 1 };
    }
    if (sql === "SELECT * FROM runs WHERE run_id = $1") {
      const r = this.visibleRuns.find((x) => x.run_id === params[0]);
      return r === undefined ? { rows: [], rowCount: 0 } : { rows: [{ ...r }], rowCount: 1 };
    }
    if (/^SELECT \* FROM tasks WHERE run_id = \$1 ORDER BY started_at ASC NULLS FIRST, task_id ASC$/u.test(sql)) {
      const rows = this.db.tasks
        .filter((t) => t.org_id === this.orgId && t.run_id === params[0])
        .sort((a, b) => a.task_id.localeCompare(b.task_id))
        .map((t) => ({ ...t }));
      return { rows, rowCount: rows.length };
    }
    if (
      /^SELECT r\.spec_id FROM tasks t INNER JOIN runs r ON r\.run_id = t\.run_id WHERE t\.task_id = \$1$/u.test(sql)
    ) {
      const task = this.db.tasks.find((t) => t.org_id === this.orgId && t.task_id === params[0]);
      const run = task === undefined ? undefined : this.visibleRuns.find((r) => r.run_id === task.run_id);
      return run === undefined ? { rows: [], rowCount: 0 } : { rows: [{ spec_id: run.spec_id }], rowCount: 1 };
    }
    if (sql === "SELECT repo_url, default_branch, config FROM projects WHERE project_id = $1") {
      const p = this.visibleProjects.find((x) => x.project_id === params[0]);
      return p === undefined
        ? { rows: [], rowCount: 0 }
        : {
            rows: [{ repo_url: p.repo_url, default_branch: p.default_branch ?? "main", config: p.config }],
            rowCount: 1,
          };
    }
    if (sql === "SELECT runner_image, config, org_id FROM projects WHERE project_id = $1") {
      const p = this.visibleProjects.find((x) => x.project_id === params[0]);
      return p === undefined
        ? { rows: [], rowCount: 0 }
        : { rows: [{ runner_image: p.runner_image, config: p.config, org_id: p.org_id }], rowCount: 1 };
    }
    return this.toolsEventCostSql(sql, params);
  }

  private toolsEventCostSql(sql: string, _params: readonly unknown[]): QueryResult | undefined {
    if (sql.startsWith("SELECT id, ts, run_id, task_id, spec_id, project_id, event_type, payload FROM events")) {
      // The conformance only exercises the no-filter shape (where = ""); return
      // every visible event in ts/id order.
      const rows = this.visibleEvents
        .slice()
        .sort((a, b) => a.ts.getTime() - b.ts.getTime() || a.id - b.id)
        .map((e) => ({
          id: e.id,
          ts: e.ts,
          run_id: e.run_id,
          task_id: null,
          spec_id: null,
          project_id: null,
          event_type: e.event_type,
          payload: e.payload,
        }));
      return { rows, rowCount: rows.length };
    }
    if (/^SELECT id, task_id, run_id, project_id, cli, provider, model,.* FROM cost_records/u.test(sql)) {
      const rows = this.db.costRecords
        .filter((c) => c.org_id === this.orgId)
        .sort((a, b) => a.recorded_at.getTime() - b.recorded_at.getTime() || a.id - b.id)
        .map((c) => ({
          id: c.id,
          run_id: c.run_id,
          project_id: c.project_id,
          cost_usd: c.cost_usd,
          recorded_at: c.recorded_at,
        }));
      return { rows, rowCount: rows.length };
    }
    return this.toolsPersonaSql(sql, _params);
  }

  private toolsPersonaSql(sql: string, params: readonly unknown[]): QueryResult | undefined {
    if (
      /^SELECT id FROM personas WHERE org_id = \( SELECT org_id FROM projects WHERE project_id = \$1 \) AND \(scope = 'org' OR project_id = \$1\)$/u.test(
        sql,
      )
    ) {
      const proj = this.visibleProjects.find((p) => p.project_id === params[0]);
      if (proj === undefined) return { rows: [], rowCount: 0 };
      const rows = this.db.personas
        .filter(
          (p) =>
            p.org_id === this.orgId && p.org_id === proj.org_id && (p.scope === "org" || p.project_id === params[0]),
        )
        .map((p) => ({ id: p.id }));
      return { rows, rowCount: rows.length };
    }
    if (
      /^SELECT id, persona_id, title, given, "when", "then", description, metadata, created_at, updated_at FROM behaviors WHERE persona_id = ANY\(\$1::text\[\]\) ORDER BY title$/u.test(
        sql,
      )
    ) {
      const personaIds = params[0] as string[];
      const rows = this.db.behaviors
        .filter((b) => b.org_id === this.orgId && personaIds.includes(b.persona_id))
        .sort((a, b) => a.title.localeCompare(b.title))
        .map((b) => ({ id: b.id, persona_id: b.persona_id, title: b.title }));
      return { rows, rowCount: rows.length };
    }
    return undefined;
  }

  private inboxSql(sql: string, params: readonly unknown[]): QueryResult | undefined {
    const visible = (): InboxSourceRec[] => this.db.inboxSources.filter((s) => s.org_id === this.orgId);
    if (sql.startsWith("INSERT INTO inbox_sources")) {
      const [id, orgId, projectId, kind, name, detail, config, enabled, autoRoute] = params as [
        string,
        string,
        string | null,
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      const rec: InboxSourceRec = {
        id,
        org_id: orgId,
        project_id: projectId,
        kind,
        name,
        detail,
        config: JSON.parse(config),
        enabled,
        auto_route: autoRoute,
        created_at: NOW,
      };
      this.db.inboxSources.push(rec);
      return { rows: [{ ...rec }], rowCount: 1 };
    }
    if (
      /^SELECT id, org_id, project_id, kind, name, detail, config, enabled, auto_route FROM inbox_sources WHERE org_id = \$1 ORDER BY created_at$/u.test(
        sql,
      )
    ) {
      const rows = visible()
        .filter((s) => s.org_id === params[0])
        .map((s) => ({ ...s }));
      return { rows, rowCount: rows.length };
    }
    if (
      /^SELECT id, org_id, project_id, kind, name, detail, config, enabled, auto_route FROM inbox_sources WHERE id = \$1$/u.test(
        sql,
      )
    ) {
      const s = visible().find((x) => x.id === params[0]);
      return s === undefined ? { rows: [], rowCount: 0 } : { rows: [{ ...s }], rowCount: 1 };
    }
    if (sql === "SELECT DISTINCT org_id FROM inbox_sources WHERE enabled = 'true'") {
      const rows = [
        ...new Set(
          visible()
            .filter((s) => s.enabled === "true")
            .map((s) => s.org_id),
        ),
      ].map((org_id) => ({ org_id }));
      return { rows, rowCount: rows.length };
    }
    return undefined;
  }

  private auditSql(sql: string, params: readonly unknown[]): QueryResult | undefined {
    const visible = (): AuditJobRec[] => this.db.auditJobs.filter((j) => j.org_id === this.orgId);
    const cols = auditCols;
    if (sql.startsWith("INSERT INTO audit_jobs")) {
      const [id, orgId, projectId, kind, name, cadence, targetWindow, answererCli, enabled] = params as [
        string,
        string,
        string | null,
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      const rec: AuditJobRec = {
        id,
        org_id: orgId,
        project_id: projectId,
        kind,
        name,
        cadence,
        target_window: targetWindow,
        answerer_cli: answererCli,
        enabled,
        last_run: null,
        findings: {},
        created_at: NOW,
      };
      this.db.auditJobs.push(rec);
      return { rows: [cols(rec)], rowCount: 1 };
    }
    if (/^SELECT .* FROM audit_jobs WHERE org_id = \$1 ORDER BY created_at$/u.test(sql)) {
      const rows = visible()
        .filter((j) => j.org_id === params[0])
        .map((j) => cols(j));
      return { rows, rowCount: rows.length };
    }
    if (/^SELECT .* FROM audit_jobs WHERE id = \$1$/u.test(sql)) {
      const j = visible().find((x) => x.id === params[0]);
      return j === undefined ? { rows: [], rowCount: 0 } : { rows: [cols(j)], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE audit_jobs SET enabled = $2, updated_at = now() WHERE id = $1 RETURNING")) {
      const j = visible().find((x) => x.id === params[0]);
      if (j !== undefined) j.enabled = params[1] as string;
      return j === undefined ? { rows: [], rowCount: 0 } : { rows: [cols(j)], rowCount: 1 };
    }
    if (
      sql.startsWith(
        "UPDATE audit_jobs SET last_run = $2, findings = $3::jsonb, updated_at = now() WHERE id = $1 RETURNING",
      )
    ) {
      const j = visible().find((x) => x.id === params[0]);
      if (j !== undefined) {
        j.last_run = params[1] as string;
        j.findings = JSON.parse(params[2] as string);
      }
      return j === undefined ? { rows: [], rowCount: 0 } : { rows: [cols(j)], rowCount: 1 };
    }
    if (sql === "SELECT DISTINCT org_id FROM audit_jobs") {
      const rows = [...new Set(visible().map((j) => j.org_id))].map((org_id) => ({ org_id }));
      return { rows, rowCount: rows.length };
    }
    return undefined;
  }
}

export function forgeRecoveryClientForOrg(db: ForgeRecoveryDb, orgId: string): QueryClient {
  return new ForgeRecoveryScopedClient(db, orgId) as unknown as QueryClient;
}
