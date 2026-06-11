// Tests for the §3.3 self-validation DRIVER (forge/inbox/claimSelfValidationDriver.ts):
// the sweep that probes each open Claim's anchor entity, decides via the pure oracle,
// persists the transition, and emits the observable event. Driven with an in-memory
// Claim store + an injectable fake producer — no runner / sem.
//
// Proves: a Claim SELF-RESOLVES when its entity is removed; STAYS OPEN when present;
// and is GRACEFUL on missing data (no false auto-resolve — a Claim never resolves on
// an `unavailable`/errored probe).

import { describe, expect, it } from "vitest";
import type pg from "pg";
import { systemActor } from "../src/engine/state/actor.js";
import { EntityClaimStore, type EntityClaim } from "../src/engine/repositories/entityClaims.js";
import {
  selfValidateProjectClaims,
  type EntityClaimProbe,
  type ClaimValidationEventSink,
} from "../src/engine/forge/inbox/claimSelfValidationDriver.js";
import type { EntityProbeOutcome } from "../src/engine/oracle/index.js";

// A minimal in-memory `entity_claims` client (one org, no RLS modeling needed here —
// the conformance suite covers RLS). Recognizes the store statements the driver uses.
interface Rec {
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

class Db {
  rows: Rec[] = [];
  seq = 0;
  // eslint-disable-next-line @typescript-eslint/require-await
  async query(rawSql: string, params: readonly unknown[] = []): Promise<{ rows: Rec[]; rowCount: number }> {
    const sql = rawSql.replaceAll(/\s+/gu, " ").trim();
    if (sql.startsWith("INSERT INTO entity_claims")) {
      const [id, orgId, projectId, candidateId, entityId, entityKind, entityName, entityPath] = params as string[];
      const rec: Rec = {
        id: id!,
        org_id: orgId!,
        project_id: projectId!,
        candidate_id: candidateId ?? null,
        entity_id: entityId!,
        entity_kind: entityKind!,
        entity_name: entityName!,
        entity_path: entityPath!,
        status: "open",
        decidability: "unchecked",
        last_validation: {},
        last_validated_at: null,
        created_at: this.seq++,
      };
      this.rows.push(rec);
      return { rows: [{ ...rec }], rowCount: 1 };
    }
    if (/FROM entity_claims WHERE project_id = \$1 AND status = 'open'/u.test(sql)) {
      const [projectId, limit] = params as [string, number];
      const rows = this.rows
        .filter((r) => r.project_id === projectId && r.status === "open")
        .sort((a, b) => (a.last_validated_at ?? -1) - (b.last_validated_at ?? -1))
        .slice(0, limit)
        .map((r) => ({ ...r }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("UPDATE entity_claims SET status = $2, decidability = $3")) {
      const [id, status, decidability, lastValidation, name, path] = params as [
        string,
        string,
        string,
        string,
        string | null,
        string | null,
      ];
      const row = this.rows.find((r) => r.id === id);
      if (row === undefined) return { rows: [], rowCount: 0 };
      row.status = status;
      row.decidability = decidability;
      row.last_validation = JSON.parse(lastValidation);
      if (name !== null) row.entity_name = name;
      if (path !== null) row.entity_path = path;
      row.last_validated_at = this.seq++;
      return { rows: [{ ...row }], rowCount: 1 };
    }
    throw new Error(`Db: unrecognized SQL: ${sql}`);
  }
}

function client(db: Db): Pick<pg.Pool, "query"> {
  return db as unknown as Pick<pg.Pool, "query">;
}

// A producer that returns a fixed outcome per entity_id (or throws when configured).
class FakeProbe implements EntityClaimProbe {
  constructor(private readonly byEntity: Map<string, EntityProbeOutcome | "throw">) {}
  // eslint-disable-next-line @typescript-eslint/require-await
  async probe(claim: EntityClaim): Promise<EntityProbeOutcome> {
    const out = this.byEntity.get(claim.entityId);
    if (out === undefined) return { status: "unavailable", unavailableReason: "no-producer" };
    if (out === "throw") throw new Error("boom");
    return out;
  }
}

class RecordingSink implements ClaimValidationEventSink {
  readonly events: { eventType: string; payload: Record<string, unknown> }[] = [];
  // eslint-disable-next-line @typescript-eslint/require-await
  async append(input: {
    projectId: string;
    eventType: "forge.claim.self_resolved" | "forge.claim.validated";
    payload: Record<string, unknown>;
  }): Promise<void> {
    this.events.push({ eventType: input.eventType, payload: input.payload });
  }
}

async function anchor(db: Db, entityId: string): Promise<EntityClaim> {
  return EntityClaimStore.anchor(
    client(db),
    { orgId: "org_a", projectId: "proj_a", candidateId: "cand_1", entityId, entityName: "fn", entityPath: "f.ts" },
    systemActor,
  );
}

describe("selfValidateProjectClaims (§3.3 self-validation sweep)", () => {
  it("SELF-RESOLVES a Claim when its anchor entity is removed", async () => {
    const db = new Db();
    await anchor(db, "ent#gone");
    const sink = new RecordingSink();
    const result = await selfValidateProjectClaims({
      client: client(db),
      projectId: "proj_a",
      prober: new FakeProbe(new Map([["ent#gone", { status: "removed" }]])),
      events: sink,
    });
    expect(result).toMatchObject({ checked: 1, selfResolved: 1, keptOpen: 0, unexpectedUnavailable: 0 });
    expect(db.rows[0]?.status).toBe("self_resolved");
    expect(sink.events.map((e) => e.eventType)).toEqual(["forge.claim.self_resolved"]);
  });

  it("KEEPS a Claim OPEN when its entity is still present", async () => {
    const db = new Db();
    await anchor(db, "ent#here");
    const sink = new RecordingSink();
    const result = await selfValidateProjectClaims({
      client: client(db),
      projectId: "proj_a",
      prober: new FakeProbe(new Map([["ent#here", { status: "present" }]])),
      events: sink,
    });
    expect(result).toMatchObject({ checked: 1, selfResolved: 0, keptOpen: 1 });
    expect(db.rows[0]?.status).toBe("open");
    expect(db.rows[0]?.decidability).toBe("decidable");
    expect(sink.events.map((e) => e.eventType)).toEqual(["forge.claim.validated"]);
  });

  it("GRACEFUL on missing data: an `unavailable` probe NEVER auto-resolves (stays open)", async () => {
    const db = new Db();
    await anchor(db, "ent#unknown");
    const result = await selfValidateProjectClaims({
      client: client(db),
      projectId: "proj_a",
      // no mapping → producer returns `unavailable` (no-producer)
      prober: new FakeProbe(new Map()),
    });
    expect(result).toMatchObject({ checked: 1, selfResolved: 0, keptOpen: 1, unexpectedUnavailable: 0 });
    expect(db.rows[0]?.status).toBe("open");
    expect(db.rows[0]?.decidability).toBe("needs_agent");
  });

  it("a producer THROW is isolated → producer-errored (loud), Claim STAYS OPEN, sweep continues", async () => {
    const db = new Db();
    await anchor(db, "ent#boom");
    await anchor(db, "ent#ok");
    const result = await selfValidateProjectClaims({
      client: client(db),
      projectId: "proj_a",
      prober: new FakeProbe(
        new Map<string, EntityProbeOutcome | "throw">([
          ["ent#boom", "throw"],
          ["ent#ok", { status: "removed" }],
        ]),
      ),
    });
    // Both checked: the throw did not halt the sweep; the second still self-resolved.
    expect(result.checked).toBe(2);
    expect(result.unexpectedUnavailable).toBe(1);
    expect(result.selfResolved).toBe(1);
    const boom = db.rows.find((r) => r.entity_id === "ent#boom");
    expect(boom?.status).toBe("open");
  });

  it("follows a RENAME: stays open and re-anchors the display name/path", async () => {
    const db = new Db();
    await anchor(db, "ent#renamed");
    await selfValidateProjectClaims({
      client: client(db),
      projectId: "proj_a",
      prober: new FakeProbe(
        new Map([["ent#renamed", { status: "renamed", renamedToName: "newName", renamedToPath: "new.ts" }]]),
      ),
    });
    const row = db.rows[0];
    expect(row?.status).toBe("open");
    expect(row?.entity_name).toBe("newName");
    expect(row?.entity_path).toBe("new.ts");
  });
});
