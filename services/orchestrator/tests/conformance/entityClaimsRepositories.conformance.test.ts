// Conformance for the §3.3 entity-anchored Claim store (`EntityClaimStore`, the
// Tanren-native defect ledger). Driven through an in-memory `pg` query target that
// — like the integration-repositories harness — models RLS row visibility: a
// client scoped to org X sees only org X's rows, so the OFF-SCOPE assertions (org B
// sees ZERO of org A's Claims) exercise the same row-filter contract the real
// org-scoped transaction provides. The harness recognizes exactly the small set of
// statements `EntityClaimStore` emits and enforces the anchor's
// (project,entity,candidate) idempotency + the RLS WITH CHECK on write.

import { describe, expect, it } from "vitest";
import type pg from "pg";
import { systemActor } from "../../src/engine/state/actor.js";
import { EntityClaimStore } from "../../src/engine/repositories/entityClaims.js";

interface ClaimRecord {
  id: string;
  org_id: string;
  project_id: string;
  candidate_id: string | null;
  entity_id: string;
  entity_kind: string;
  entity_name: string;
  entity_path: string;
  status: string;
  decidability: string;
  last_validation: unknown;
  last_validated_at: number | null;
  created_at: number;
}

class ClaimMemoryDb {
  readonly claims: ClaimRecord[] = [];
  seq = 0;
}

interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

// A `pg`-shaped client bound to one org scope. Reads/writes only touch rows whose
// org matches the scope (RLS). The anchor INSERT...ON CONFLICT is keyed on
// (project_id, entity_id, candidate_id).
class ScopedClient {
  constructor(
    private readonly db: ClaimMemoryDb,
    private readonly orgId: string,
  ) {}

  private visible(): ClaimRecord[] {
    return this.db.claims.filter((r) => r.org_id === this.orgId);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async query(rawSql: string, params: readonly unknown[] = []): Promise<QueryResult> {
    const sql = rawSql.replaceAll(/\s+/gu, " ").trim();

    if (sql.startsWith("INSERT INTO entity_claims")) {
      const [id, orgId, projectId, candidateId, entityId, entityKind, entityName, entityPath] = params as [
        string,
        string,
        string,
        string | null,
        string,
        string,
        string,
        string,
      ];
      // RLS WITH CHECK: a write must target the scoped org.
      if (orgId !== this.orgId) {
        throw new Error("new row violates row-level security policy for table entity_claims");
      }
      // Idempotency key: (project_id, entity_id, candidate_id).
      const existing = this.db.claims.find(
        (r) => r.project_id === projectId && r.entity_id === entityId && r.candidate_id === candidateId,
      );
      if (existing !== undefined) {
        existing.entity_kind = entityKind;
        existing.entity_name = entityName;
        existing.entity_path = entityPath;
        return { rows: [{ ...existing }], rowCount: 1 };
      }
      const rec: ClaimRecord = {
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
        last_validated_at: null,
        created_at: this.db.seq++,
      };
      this.db.claims.push(rec);
      return { rows: [{ ...rec }], rowCount: 1 };
    }

    if (/FROM entity_claims WHERE id = \$1/u.test(sql)) {
      const [id] = params as [string];
      const rows = this.visible().filter((r) => r.id === id);
      return { rows: rows.map((r) => ({ ...r })), rowCount: rows.length };
    }

    if (/FROM entity_claims WHERE candidate_id = \$1/u.test(sql)) {
      const [candidateId] = params as [string];
      const rows = this.visible()
        .filter((r) => r.candidate_id === candidateId)
        .sort((a, b) => b.created_at - a.created_at);
      return { rows: rows.map((r) => ({ ...r })), rowCount: rows.length };
    }

    if (/FROM entity_claims WHERE project_id = \$1 AND status = 'open'/u.test(sql)) {
      const [projectId, limit] = params as [string, number];
      const rows = this.visible()
        .filter((r) => r.project_id === projectId && r.status === "open")
        .sort((a, b) => (a.last_validated_at ?? -1) - (b.last_validated_at ?? -1))
        .slice(0, limit);
      return { rows: rows.map((r) => ({ ...r })), rowCount: rows.length };
    }

    if (sql.startsWith("UPDATE entity_claims SET status = $2, decidability = $3")) {
      // recordValidation: id, status, decidability, lastValidation, name, path, resolved
      const [id, status, decidability, lastValidation, name, path, resolved] = params as [
        string,
        string,
        string,
        string,
        string | null,
        string | null,
        boolean,
      ];
      const row = this.visible().find((r) => r.id === id);
      if (row === undefined) return { rows: [], rowCount: 0 };
      row.status = status;
      row.decidability = decidability;
      row.last_validation = JSON.parse(lastValidation);
      if (name !== null) row.entity_name = name;
      if (path !== null) row.entity_path = path;
      row.last_validated_at = this.db.seq++;
      void resolved;
      return { rows: [{ ...row }], rowCount: 1 };
    }

    if (sql.startsWith("UPDATE entity_claims SET status = $2, resolved_at = now")) {
      // resolveByAgent: id, status
      const [id, status] = params as [string, string];
      const row = this.visible().find((r) => r.id === id);
      if (row === undefined) return { rows: [], rowCount: 0 };
      row.status = status;
      return { rows: [{ ...row }], rowCount: 1 };
    }

    if (/SELECT DISTINCT org_id FROM entity_claims/u.test(sql)) {
      // System-scoped fan-out: spans all orgs (no RLS filter in this harness path).
      const orgs = [...new Set(this.db.claims.map((r) => r.org_id))];
      return { rows: orgs.map((org_id) => ({ org_id })), rowCount: orgs.length };
    }

    throw new Error(`ClaimMemoryDb: unrecognized SQL: ${sql}`);
  }
}

function clientForOrg(db: ClaimMemoryDb, orgId: string): Pick<pg.Pool, "query"> {
  return new ScopedClient(db, orgId) as unknown as Pick<pg.Pool, "query">;
}

describe("EntityClaimStore conformance (in-memory pg, RLS-modeled)", () => {
  it("anchor → get/listForCandidate round-trips; defaults are open/unchecked", async () => {
    const db = new ClaimMemoryDb();
    const a = clientForOrg(db, "org_a");
    const claim = await EntityClaimStore.anchor(
      a,
      {
        orgId: "org_a",
        projectId: "proj_a",
        candidateId: "cand_1",
        entityId: "ent#hash1",
        entityKind: "function",
        entityName: "parseUserToken",
        entityPath: "src/auth.ts",
      },
      systemActor,
    );
    expect(claim.status).toBe("open");
    expect(claim.decidability).toBe("unchecked");
    expect(claim.entityId).toBe("ent#hash1");

    const got = await EntityClaimStore.get(a, claim.id, systemActor);
    expect(got?.entityName).toBe("parseUserToken");

    const forCand = await EntityClaimStore.listForCandidate(a, "cand_1", systemActor);
    expect(forCand).toHaveLength(1);
  });

  it("anchor is idempotent on (project, entity, candidate) — re-anchor updates, never duplicates", async () => {
    const db = new ClaimMemoryDb();
    const a = clientForOrg(db, "org_a");
    const base = { orgId: "org_a", projectId: "proj_a", candidateId: "cand_1", entityId: "ent#hash1" };
    await EntityClaimStore.anchor(a, { ...base, entityName: "parseUserToken" }, systemActor);
    await EntityClaimStore.anchor(a, { ...base, entityName: "parseUserToken_v2" }, systemActor);
    const forCand = await EntityClaimStore.listForCandidate(a, "cand_1", systemActor);
    expect(forCand).toHaveLength(1);
    expect(forCand[0]?.entityName).toBe("parseUserToken_v2");
  });

  it("recordValidation self-resolves; listOpenForProject then excludes it", async () => {
    const db = new ClaimMemoryDb();
    const a = clientForOrg(db, "org_a");
    const claim = await EntityClaimStore.anchor(
      a,
      { orgId: "org_a", projectId: "proj_a", candidateId: "cand_1", entityId: "ent#hash1" },
      systemActor,
    );
    expect(await EntityClaimStore.listOpenForProject(a, "proj_a", 100, systemActor)).toHaveLength(1);

    const updated = await EntityClaimStore.recordValidation(
      a,
      claim.id,
      {
        status: "self_resolved",
        decidability: "decidable",
        lastValidation: { rationale: "entity gone" },
        resolved: true,
      },
      systemActor,
    );
    expect(updated?.status).toBe("self_resolved");
    expect(updated?.lastValidation).toEqual({ rationale: "entity gone" });
    expect(await EntityClaimStore.listOpenForProject(a, "proj_a", 100, systemActor)).toHaveLength(0);
  });

  it("resolveByAgent marks agent_resolved / dismissed", async () => {
    const db = new ClaimMemoryDb();
    const a = clientForOrg(db, "org_a");
    const claim = await EntityClaimStore.anchor(
      a,
      { orgId: "org_a", projectId: "proj_a", candidateId: "cand_1", entityId: "ent#hash1" },
      systemActor,
    );
    const resolved = await EntityClaimStore.resolveByAgent(a, claim.id, "agent_resolved", systemActor);
    expect(resolved?.status).toBe("agent_resolved");
  });

  it("off-org → zero rows (RLS): org B sees none of org A's Claims, and cannot write into org A", async () => {
    const db = new ClaimMemoryDb();
    const a = clientForOrg(db, "org_a");
    const claim = await EntityClaimStore.anchor(
      a,
      { orgId: "org_a", projectId: "proj_a", candidateId: "cand_1", entityId: "ent#hash1" },
      systemActor,
    );
    const b = clientForOrg(db, "org_b");
    expect(await EntityClaimStore.get(b, claim.id, systemActor)).toBeUndefined();
    expect(await EntityClaimStore.listForCandidate(b, "cand_1", systemActor)).toHaveLength(0);
    expect(await EntityClaimStore.listOpenForProject(b, "proj_a", 100, systemActor)).toHaveLength(0);
    // An off-scope client cannot resolve org A's Claim (RLS bounds the UPDATE to zero rows).
    expect(
      await EntityClaimStore.recordValidation(
        b,
        claim.id,
        { status: "self_resolved", decidability: "decidable", lastValidation: {}, resolved: true },
        systemActor,
      ),
    ).toBeUndefined();
    // The WITH CHECK rejects a write that targets a different org.
    await expect(
      EntityClaimStore.anchor(
        b,
        { orgId: "org_a", projectId: "proj_a", candidateId: "cand_2", entityId: "ent#x" },
        systemActor,
      ),
    ).rejects.toThrow(/row-level security/u);
  });
});
