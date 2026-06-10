// SHARED project-bootstrap provisioning seam (Codex round-4): every project-create path
// (onboarding · greenfield · brownfield) calls `provisionAutonomousProject` to seed the
// COMPLETE autonomous-project set — the audit-job catalog, the per-org default
// notification route, AND the issues inbox source. These prove: a single call seeds all
// three; it is idempotent (a re-provision adds nothing new); each is org-scoped.
//
// A combined SQL-substring stub pool: notification SQL is delegated to the shared
// NotificationMemoryClient; audit_jobs + inbox_sources are handled inline. TEST FIXTURE only.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import { provisionAutonomousProject } from "../src/engine/workflow/provisionAutonomousProject.js";
import { AUDIT_BOOTSTRAP_CATALOG } from "../src/engine/forge/audits/index.js";
import { DEFAULT_ROUTE_EVENTS } from "../src/engine/notifications/index.js";
import { NotificationMemoryClient } from "./helpers/notificationMemoryClient.js";

function stubPool(failOn?: (sql: string) => boolean): {
  pool: pg.Pool;
  auditJobs: Map<string, Record<string, unknown>>;
  inboxSources: Map<string, Record<string, unknown>>;
  notify: NotificationMemoryClient;
} {
  const auditJobs = new Map<string, Record<string, unknown>>();
  const inboxSources = new Map<string, Record<string, unknown>>();
  const notify = new NotificationMemoryClient();
  let seq = 0;

  const query = async (text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
    const sql = text.replaceAll(/\s+/gu, " ").trim();
    if (failOn?.(sql) === true) throw new Error(`stub failOn: ${sql}`);
    if (sql === "BEGIN" || sql === "COMMIT" || sql.startsWith("SET LOCAL")) return { rows: [], rowCount: 0 };

    if (sql.startsWith("INSERT INTO audit_jobs")) {
      const [id, orgId, projectId, kind, name, cadence, targetWindow, answererCli, enabled] = params as (
        | string
        | null
      )[];
      const row = {
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
        findings: { count: 0, severity: "ok", note: "" },
        created_at: seq++,
      };
      auditJobs.set(String(id), row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith("SELECT") && sql.includes("FROM audit_jobs WHERE org_id")) {
      const list = [...auditJobs.values()]
        .filter((r) => r.org_id === params[0])
        .sort((a, b) => Number(a.created_at) - Number(b.created_at));
      return { rows: list, rowCount: list.length };
    }

    if (sql.startsWith("INSERT INTO inbox_sources")) {
      const [id, orgId, projectId, kind, name, detail, config, enabled, autoRoute] = params as (string | null)[];
      const row = {
        id,
        org_id: orgId,
        project_id: projectId,
        kind,
        name,
        detail,
        config: typeof config === "string" ? JSON.parse(config) : config,
        enabled,
        auto_route: autoRoute,
      };
      inboxSources.set(String(id), row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith("SELECT") && sql.includes("FROM inbox_sources WHERE org_id")) {
      const list = [...inboxSources.values()].filter((r) => r.org_id === params[0]);
      return { rows: list, rowCount: list.length };
    }

    if (sql.includes("notification_targets") || sql.includes("notification_routes")) {
      return notify.query(text, params) as Promise<{ rows: unknown[]; rowCount: number }>;
    }
    return { rows: [], rowCount: 0 };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  return { pool: pool as unknown as pg.Pool, auditJobs, inboxSources, notify };
}

const REPO_URL = "https://github.com/cat-cave/apex-url-shortener.git";

describe("provisionAutonomousProject (shared bootstrap seam)", () => {
  it("seeds the COMPLETE set — audit catalog + default notification route + issues inbox", async () => {
    const { pool, auditJobs, inboxSources, notify } = stubPool();
    const result = await provisionAutonomousProject({
      pool,
      orgId: "org_a",
      projectId: "project_a",
      repoUrl: REPO_URL,
    });

    // No seed failed.
    expect(result.errors).toEqual([]);

    // 1. Audit catalog seeded.
    expect(result.auditCatalog?.jobs).toBe(AUDIT_BOOTSTRAP_CATALOG.length);
    expect(result.auditCatalog?.created.sort()).toEqual(["deps", "mutation", "security", "stale_specs"]);
    expect(auditJobs.size).toBe(AUDIT_BOOTSTRAP_CATALOG.length);

    // 2. Default notification route seeded (every milestone event has a route).
    expect(result.notificationRoute?.created).toBe(true);
    expect(result.notificationRoute?.events).toBe(DEFAULT_ROUTE_EVENTS.length);
    expect(notify.targets.size).toBe(1);
    expect(notify.routes.size).toBe(DEFAULT_ROUTE_EVENTS.length);

    // 3. Issues inbox seeded for the repo.
    expect(result.inboxSource?.created).toBe(true);
    expect(inboxSources.size).toBe(1);
    expect([...inboxSources.values()][0]!.kind).toBe("issues");
  });

  it("is idempotent — a re-provision adds nothing new", async () => {
    const { pool, auditJobs, inboxSources, notify } = stubPool();
    await provisionAutonomousProject({ pool, orgId: "org_a", projectId: "project_a", repoUrl: REPO_URL });
    const second = await provisionAutonomousProject({
      pool,
      orgId: "org_a",
      projectId: "project_a",
      repoUrl: REPO_URL,
    });

    expect(second.errors).toEqual([]);
    expect(second.auditCatalog?.created).toEqual([]);
    expect(second.notificationRoute?.created).toBe(false);
    expect(second.inboxSource?.created).toBe(false);
    // No duplicate rows anywhere.
    expect(auditJobs.size).toBe(AUDIT_BOOTSTRAP_CATALOG.length);
    expect(inboxSources.size).toBe(1);
    expect(notify.targets.size).toBe(1);
    expect(notify.routes.size).toBe(DEFAULT_ROUTE_EVENTS.length);
  });

  it("isolates a seed failure (LOUD, no silent strand) — a failing audit seed still seeds inbox + route", async () => {
    // Make ONLY the audit-catalog seed throw (its listAuditJobs read); the inbox +
    // route seeds are untouched.
    const { pool, inboxSources, notify } = stubPool((sql) => sql.includes("FROM audit_jobs WHERE org_id"));

    const result = await provisionAutonomousProject({
      pool,
      orgId: "org_a",
      projectId: "project_a",
      repoUrl: REPO_URL,
    });

    // The audit seed failure is recorded LOUD — never a silent strand.
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.seed).toBe("auditCatalog");
    expect(result.auditCatalog).toBeUndefined();
    // But the OTHER seeds still landed (isolation): the inbox + route a live run needs.
    expect(result.inboxSource?.created).toBe(true);
    expect(result.notificationRoute?.created).toBe(true);
    expect(inboxSources.size).toBe(1);
    expect(notify.routes.size).toBe(DEFAULT_ROUTE_EVENTS.length);
  });
});
