// Loop 6 — org-scoped feature requests must NEVER silent-stall in the inbox.
//
// A routable feature request can arrive with `projectId: null` (an org-scoped /
// default source). The auto-route guard `candidate.projectId !== null` would then
// silently drop it in the inbox — triaged-as-routable but never a spec. These
// tests prove the project-placement resolver closes that gap:
//   1. an org with exactly ONE project → the candidate is PLACED there and becomes
//      a DAG spec (auto_routed), not stuck.
//   2. an ambiguous org (0 or >1 projects) → needs_attention (LOUD), the candidate
//      rests at `triaged`, never a silent pass-through.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import { intakeItem, intakeAutoRouteDeps } from "../src/engine/forge/intake/index.js";
import type {
  CandidateTriage,
  InboxSource,
  TriageAnswerer,
  TriageRoutableSpec,
} from "../src/engine/forge/inbox/index.js";

// An org-scoped (project-less) autonomous source: this is the exact shape that
// produced the stall — a routable candidate with no project to commit into.
const orgScopedSource: InboxSource = {
  id: "src_org",
  orgId: "org_a",
  projectId: null,
  kind: "system",
  name: "org default intake",
  detail: "",
  config: {},
  enabled: true,
  autoRoute: true,
};

function routableTriage(routableSpec: TriageRoutableSpec): TriageAnswerer {
  return {
    async triage(): Promise<CandidateTriage> {
      return {
        dedupe: "no match",
        match: "new feature",
        placement: "auto",
        verdict: "auto_routable",
        duplicateOfSpecId: null,
        discoveryVariant: "feature",
        routableSpec,
      };
    },
  };
}

const routableSpec: TriageRoutableSpec = {
  title: "add a vanity-slug option",
  description: "let a user pick the short code",
  acceptanceCriteria: ["custom slug accepted", "collision rejected"],
  dependsOn: [],
  priority: "P2",
};

// A SQL-substring stub pool with a configurable project list for the org. The
// candidate is upserted with project_id = null (the source's projectId), then the
// placement resolver lists the org's projects and (on a single project) places it
// before auto-route inserts the spec.
function stubPool(opts: { projects: string[] }): {
  pool: pg.Pool;
  candidates: Map<string, Record<string, unknown>>;
  specInserts: string[];
} {
  const candidates = new Map<string, Record<string, unknown>>();
  const byExternal = new Map<string, string>();
  const specInserts: string[] = [];
  const row = (id: string) => {
    const c = candidates.get(id)!;
    return { ...c, source_name: orgScopedSource.name, source_kind: orgScopedSource.kind };
  };
  const query = async (text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
    const sql = text.replaceAll(/\s+/gu, " ").trim();
    if (sql.startsWith("SELECT spec_id, title, status FROM specs")) return { rows: [], rowCount: 0 };
    // The placement resolver's project list (ProjectStore.listForOrg).
    if (sql.includes("FROM projects WHERE org_id = $1")) {
      const rows = opts.projects.map((id) => ({
        project_id: id,
        name: id,
        repo_url: `https://github.com/o/${id}`,
        default_branch: "main",
        runner_image: "img",
        allocator: "static",
        config: {},
        lifecycle: "active",
      }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("INSERT INTO candidates")) {
      const [id, sourceId, orgId, projectId, externalId, title, body, severity, status, triage] = params as string[];
      const key = `${sourceId}::${externalId}`;
      const cid = byExternal.get(key) ?? id;
      candidates.set(cid, {
        id: cid,
        source_id: sourceId,
        org_id: orgId,
        project_id: projectId,
        external_id: externalId,
        title,
        body,
        severity,
        status,
        triage: JSON.parse(triage),
        resolved_spec_id: null,
      });
      byExternal.set(key, cid);
      return { rows: [row(cid)], rowCount: 1 };
    }
    if (sql.startsWith("SELECT c.id, c.source_id") && sql.includes("WHERE c.id = $1")) {
      const c = candidates.get(String(params[0]));
      return c === undefined ? { rows: [], rowCount: 0 } : { rows: [row(String(params[0]))], rowCount: 1 };
    }
    // placeCandidateProject (update project_id).
    if (sql.startsWith("UPDATE candidates c SET project_id")) {
      const [cid, projectId] = params as string[];
      const c = candidates.get(String(cid));
      if (c === undefined) return { rows: [], rowCount: 0 };
      c.project_id = projectId;
      return { rows: [row(String(cid))], rowCount: 1 };
    }
    // resolveCandidate (status flip on the needs_attention escalation).
    if (sql.startsWith("UPDATE candidates c SET status")) {
      const [cid, status, specId] = params as (string | null)[];
      const c = candidates.get(String(cid));
      if (c === undefined) return { rows: [], rowCount: 0 };
      c.status = status;
      c.resolved_spec_id = specId;
      return { rows: [row(String(cid))], rowCount: 1 };
    }
    // discovery acceptProposals → createSpec.
    if (sql.startsWith("SELECT project_id FROM projects")) return { rows: [{ project_id: params[0] }], rowCount: 1 };
    if (sql.startsWith("SELECT org_id FROM projects")) return { rows: [{ org_id: "org_a" }], rowCount: 1 };
    if (sql.startsWith("INSERT INTO specs")) {
      specInserts.push(String(params[0]));
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("SELECT metadata FROM specs")) return { rows: [{ metadata: {} }], rowCount: 1 };
    if (sql.startsWith("UPDATE specs SET metadata")) return { rows: [{ spec_id: params[0] }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  return { pool: pool as unknown as pg.Pool, candidates, specInserts };
}

const item = {
  externalId: "report-1",
  title: "add a vanity-slug option",
  body: "details",
  severity: "info" as const,
  projectId: null,
};

describe("intake project placement (Loop 6)", () => {
  it("places a project-less routable request into the org's single project and routes it to a spec", async () => {
    const { pool, specInserts, candidates } = stubPool({ projects: ["project_only"] });
    const outcome = await intakeItem(
      { pool, answerer: routableTriage(routableSpec), autoRoute: intakeAutoRouteDeps() },
      orgScopedSource,
      item,
    );
    expect(outcome.kind).toBe("auto_routed");
    if (outcome.kind !== "auto_routed") throw new Error("unreachable");
    // The candidate was PLACED into the org's single project — not stalled.
    expect(outcome.candidate.projectId).toBe("project_only");
    expect(outcome.candidate.status).toBe("accepted");
    expect(specInserts).toHaveLength(1);
    expect([...candidates.values()][0]!.project_id).toBe("project_only");
  });

  it("escalates to needs_attention (LOUD) when the org has NO project (never a silent stall)", async () => {
    const { pool, specInserts, candidates } = stubPool({ projects: [] });
    const outcome = await intakeItem(
      { pool, answerer: routableTriage(routableSpec), autoRoute: intakeAutoRouteDeps() },
      orgScopedSource,
      item,
    );
    expect(outcome.kind).toBe("needs_attention");
    if (outcome.kind !== "needs_attention") throw new Error("unreachable");
    expect(outcome.reason).toBe("no_project");
    // No spec was committed; the candidate rests at the loud inbox surface, NOT
    // silently passed through as routable.
    expect(specInserts).toHaveLength(0);
    expect(outcome.candidate.status).toBe("triaged");
    expect([...candidates.values()][0]!.status).toBe("triaged");
  });

  it("escalates to needs_attention when the org has MULTIPLE projects (ambiguous — a human chooses)", async () => {
    const { pool, specInserts } = stubPool({ projects: ["project_a", "project_b"] });
    const outcome = await intakeItem(
      { pool, answerer: routableTriage(routableSpec), autoRoute: intakeAutoRouteDeps() },
      orgScopedSource,
      item,
    );
    expect(outcome.kind).toBe("needs_attention");
    if (outcome.kind !== "needs_attention") throw new Error("unreachable");
    expect(outcome.reason).toBe("multiple_projects");
    expect(specInserts).toHaveLength(0);
  });
});
