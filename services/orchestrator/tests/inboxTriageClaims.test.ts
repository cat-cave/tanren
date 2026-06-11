// §3.3: the issue-triage lane CREATES + CONSULTS entity-anchored Claims.
//
// When triage processes an issue whose read-out carries an `entityAnchor`, the
// engine ANCHORS a durable Claim to the entity's structural-hash identity and emits
// `forge.claim.anchored`. And when a candidate already carries a SELF-RESOLVED Claim
// (a prior triage anchored it to an entity since refactored away), the engine
// CONSULTS the ledger and does NOT re-route it as live — it closes it as stale.
//
// Self-contained in-memory pool (candidates + entity_claims) + a fake connector +
// a fake answerer; no provider/GitHub/runner.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import {
  ingestSource,
  type InboxEngineDeps,
  type InboxSource,
  type SourceConnector,
  type CandidateTriage,
  type TriageAnswerer,
  type TriageAnswererContext,
  type IngestedItem,
} from "../src/engine/forge/inbox/index.js";

const issuesSource: InboxSource = {
  id: "src_gh",
  orgId: "org_a",
  projectId: "project_a",
  kind: "issues",
  name: "github · cat-cave",
  detail: "",
  config: {},
  enabled: true,
  autoRoute: false,
};

const baseTriage: CandidateTriage = {
  dedupe: "no dup",
  match: "new behavior",
  placement: "backlog",
  verdict: "needs_call",
  duplicateOfSpecId: null,
  discoveryVariant: "bug",
  routableSpec: null,
  entityAnchor: null,
};

// A connector that yields one fixed item.
function fakeConnector(item: IngestedItem): SourceConnector {
  return {
    kind: "issues",
    // eslint-disable-next-line @typescript-eslint/require-await
    async fetch(): Promise<IngestedItem[]> {
      return [item];
    },
  };
}

// A fake answerer returning a fixed triage read-out.
function fakeAnswerer(triage: CandidateTriage): TriageAnswerer {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async triage(_ctx: TriageAnswererContext): Promise<CandidateTriage> {
      return triage;
    },
  };
}

// In-memory pool: candidates + entity_claims, keyed by SQL substring.
function stubPool(seedSelfResolvedFor?: string): {
  pool: pg.Pool;
  claims: Map<string, Record<string, unknown>>;
  candidates: Map<string, Record<string, unknown>>;
} {
  const candidates = new Map<string, Record<string, unknown>>();
  const byExternal = new Map<string, string>();
  const claims = new Map<string, Record<string, unknown>>();
  let claimSeq = 0;

  const candidateRow = (id: string) => ({
    ...candidates.get(id)!,
    source_name: issuesSource.name,
    source_kind: "issues",
  });

  const query = async (text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
    const sql = text.replaceAll(/\s+/gu, " ").trim();

    if (sql.startsWith("SELECT spec_id, title, status FROM specs")) return { rows: [], rowCount: 0 };

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
      // If asked, seed a SELF-RESOLVED claim for this candidate id (the consult case).
      if (seedSelfResolvedFor !== undefined && claims.size === 0) {
        claims.set("seed", {
          id: "claim_seed",
          org_id: orgId,
          project_id: projectId,
          candidate_id: cid,
          entity_id: "ent#old",
          entity_kind: "function",
          entity_name: "old",
          entity_path: "f.ts",
          status: "self_resolved",
          decidability: "decidable",
          last_validation: {},
        });
      }
      return { rows: [candidateRow(cid)], rowCount: 1 };
    }

    if (sql.startsWith("UPDATE candidates c SET status")) {
      const [cid, status, specId] = params as (string | null)[];
      const c = candidates.get(String(cid));
      if (c === undefined) return { rows: [], rowCount: 0 };
      c.status = status;
      c.resolved_spec_id = specId;
      return { rows: [candidateRow(String(cid))], rowCount: 1 };
    }

    // --- entity_claims ---
    if (sql.includes("FROM entity_claims WHERE candidate_id = $1")) {
      const [candidateId] = params as [string];
      const rows = [...claims.values()].filter((c) => c.candidate_id === candidateId);
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("INSERT INTO entity_claims")) {
      const [id, orgId, projectId, candidateId, entityId, entityKind, entityName, entityPath] = params as string[];
      const rec = {
        id,
        org_id: orgId,
        project_id: projectId,
        candidate_id: candidateId,
        entity_id: entityId,
        entity_kind: entityKind,
        entity_name: entityName,
        entity_path: entityPath,
        status: "open",
        decidability: "unchecked",
        last_validation: {},
      };
      claims.set(`claim_${claimSeq++}`, rec);
      return { rows: [rec], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  };

  const pool = { query, connect: async () => ({ query, release() {} }) };
  return { pool: pool as unknown as pg.Pool, claims, candidates };
}

const item: IngestedItem = {
  externalId: "gh#1",
  title: "500 in parseUserToken",
  body: "stack trace",
  severity: "fail",
  projectId: "project_a",
};

function depsFor(
  pool: pg.Pool,
  triage: CandidateTriage,
  withLedger: boolean,
  sink?: InboxEngineDeps["claimLedger"],
): InboxEngineDeps {
  return {
    pool,
    connectors: new Map<string, SourceConnector>([["issues", fakeConnector(item)]]),
    answerer: fakeAnswerer(triage),
    ...(withLedger && { claimLedger: sink ?? {} }),
  };
}

describe("issue-triage lane — entity-anchored Claims (§3.3)", () => {
  it("ANCHORS a durable Claim from the triage's entityAnchor + emits forge.claim.anchored", async () => {
    const { pool, claims } = stubPool();
    const emitted: { eventType: string; payload: Record<string, unknown> }[] = [];
    const sink = {
      events: {
        // eslint-disable-next-line @typescript-eslint/require-await
        async append(input: { eventType: string; payload: Record<string, unknown> }) {
          emitted.push({ eventType: input.eventType, payload: input.payload });
        },
      },
    };
    const triage: CandidateTriage = {
      ...baseTriage,
      entityAnchor: { entityId: "ent#hash", kind: "function", name: "parseUserToken", path: "src/auth.ts" },
    };
    await ingestSource(depsFor(pool, triage, true, sink), issuesSource);

    const anchored = [...claims.values()].filter((c) => c.entity_id === "ent#hash");
    expect(anchored).toHaveLength(1);
    expect(anchored[0]?.entity_name).toBe("parseUserToken");
    expect(emitted.map((e) => e.eventType)).toContain("forge.claim.anchored");
  });

  it("with NO entityAnchor: anchors no Claim (graceful — a broad request stays ledger-less)", async () => {
    const { pool, claims } = stubPool();
    await ingestSource(depsFor(pool, baseTriage, true), issuesSource);
    expect(claims.size).toBe(0);
  });

  it("with no ledger wired: behaves exactly as before (inert, no Claim)", async () => {
    const { pool, claims } = stubPool();
    const triage: CandidateTriage = {
      ...baseTriage,
      entityAnchor: { entityId: "ent#hash", kind: "function", name: "fn", path: "f.ts" },
    };
    await ingestSource(depsFor(pool, triage, false), issuesSource);
    expect(claims.size).toBe(0);
  });

  it("CONSULTS the ledger: a candidate with a self-resolved Claim is closed as stale, not re-routed", async () => {
    const { pool, candidates } = stubPool("seed");
    await ingestSource(depsFor(pool, baseTriage, true), issuesSource);
    const c = [...candidates.values()][0];
    // The consult closed it as stale (closed_duplicate) rather than leaving it live.
    expect(c?.status).toBe("closed_duplicate");
  });
});
