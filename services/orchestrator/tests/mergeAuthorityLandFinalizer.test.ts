// in-16 — TRANSACTIONAL DELIVERY OUTBOX on authorized land (integrations.md §F).
//
// Proves that `applyFinalizeLand` — the ONE org-scoped land transaction — now ALSO
// enqueues a durable `delivery_runs` outbox row alongside `merge.completed` + the spec
// `merged` flip, so there is never a "merged but nobody scheduled delivery" gap. The
// three claims, each a named test:
//   (1) POSITIVE — an authorized land writes the `merge.completed` record AND exactly
//       ONE `delivery_runs` row (bound to the merge SHA + the authorizing decision) in
//       ONE transaction.
//   (2) ATOMICITY (negative control) — a finalize failure AFTER the external land (here:
//       the delivery FK cannot resolve) ROLLS BACK the whole record: NO merge.completed,
//       NO spec flip, NO half-written outbox row.
//   (3) IDEMPOTENCY — a `merge_state_unknown` reconcile RETRY re-runs the applier with
//       the same key and inserts exactly ONE row, never two (`ON CONFLICT DO NOTHING`).
//
// Gated behind TANREN_RLS_DB_TEST=1 + a superuser DATABASE_URL (the same ephemeral-DB
// harness the writer-backed conformance suite uses). Wired into `just smoke`.
//
// NOTE ON THE FROZEN EVENT VOCABULARY: this node emits NO new event. The wave-1 freeze
// (db/migrations/0046 + the event registry) contains no `delivery.*` / outbox-enqueued
// name, so per the orchestration doctrine (emit only an already-frozen name, never
// invent one) the outbox is proven by the DURABLE ROW, not a bespoke event. The land's
// existing `merge.completed` remains the terminal governing event.

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate, runWithOrgScope } from "@tanren/db";
import { InMemoryCodeHost } from "./conformance/fakes/inMemoryCodeHost.js";
import { CONF_ENVELOPE, confAllClearInput } from "./conformance/mergeAuthorityConformance.js";
import { MergeAuthorityV2Impl, SubjectEqualityRevalidator } from "../src/engine/merge/mergeAuthorityV2Impl.js";
import {
  applyFinalizeLand,
  buildAuthorityLandStore,
  type LandFinalizeContext,
} from "../src/engine/merge/mergeAuthorityLandFinalizer.js";
import { DirectRunStateWriter } from "../src/engine/worker/directRunStateWriter.js";
import { serviceAuditActor } from "../src/engine/events/schemas/audit.js";
import type { FinalizeLandInput } from "../src/engine/contracts/runStateWriter.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const REPO = { owner: "owner", name: "repo" };
const ORG_ID = "org_outbox";
const PROJECT_ID = "proj_outbox";
const SPEC_ID = CONF_ENVELOPE.members[0]!.specId;
const RUN_ID = CONF_ENVELOPE.members[0]!.runId;
const TASK_ID = "task_outbox_merge";
// The deterministic authority_decisions.id the land persists (subject + headSha), which
// the delivery-outbox row is FK-bound to — must MATCH `authorityDecisionIdFor`.
const DECISION_ID = `decision-${CONF_ENVELOPE.subject.id}-${CONF_ENVELOPE.headSha}`;

function dbName(): string {
  return `tanren_outbox_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function landContext(): LandFinalizeContext {
  return {
    orgId: ORG_ID,
    runId: RUN_ID,
    specId: SPEC_ID,
    projectId: PROJECT_ID,
    taskId: TASK_ID,
    prUrl: "https://github.com/owner/repo/pull/1",
    prNumber: 1,
    integration: "native_queue",
    auditEnvelope: { policyVersion: 1, initiatingActor: serviceAuditActor },
  };
}

/** A finalize input the direct applier can be driven with (atomicity + idempotency probes). */
function finalizeInput(overrides: Partial<FinalizeLandInput> = {}): FinalizeLandInput {
  return {
    orgId: ORG_ID,
    runId: RUN_ID,
    specId: SPEC_ID,
    projectId: PROJECT_ID,
    taskId: TASK_ID,
    prUrl: "https://github.com/owner/repo/pull/1",
    prNumber: 1,
    integration: "native_queue",
    mergeSha: "sha-node-built",
    authorityDecisionId: DECISION_ID,
    auditEnvelope: { policyVersion: 1, initiatingActor: serviceAuditActor },
    ...overrides,
  };
}

async function seedTenant(owner: Pool): Promise<void> {
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [ORG_ID],
  );
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, org_id)
     VALUES ($1, 'p', 'https://example.com/r.git', $2)`,
    [PROJECT_ID, ORG_ID],
  );
  await owner.query(
    `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
     VALUES ($1, $2, $3, 't', 'd', 'in_flight')`,
    [SPEC_ID, PROJECT_ID, ORG_ID],
  );
  await owner.query(
    `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
     VALUES ($1, $2, $3, $4, 'cli', 'main', 'running')`,
    [RUN_ID, SPEC_ID, PROJECT_ID, ORG_ID],
  );
  await owner.query(
    `INSERT INTO tasks (task_id, run_id, org_id, kind, title, status, agent_kind, cli)
     VALUES ($1, $2, $3, 'merge', 'Merge pull request', 'running', 'system', 'codex')`,
    [TASK_ID, RUN_ID, ORG_ID],
  );
}

describeDb("in-16 — transactional delivery outbox on authorized land", () => {
  const database = dbName();
  let ownerPool: Pool;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();
    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(ownerPool);
  }, 60_000);

  afterAll(async () => {
    await ownerPool?.end();
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
    await adminPool.end();
  }, 30_000);

  beforeEach(async () => {
    await ownerPool.query("DELETE FROM delivery_run_bindings WHERE org_id = $1", [ORG_ID]);
    await ownerPool.query("DELETE FROM delivery_runs WHERE org_id = $1", [ORG_ID]);
    await ownerPool.query("DELETE FROM events WHERE org_id = $1", [ORG_ID]);
    await ownerPool.query("DELETE FROM tasks WHERE run_id = $1", [RUN_ID]);
    await ownerPool.query("DELETE FROM runs WHERE org_id = $1", [ORG_ID]);
    await ownerPool.query("DELETE FROM specs WHERE org_id = $1", [ORG_ID]);
    await ownerPool.query("DELETE FROM authority_land_receipts WHERE org_id = $1", [ORG_ID]);
    await ownerPool.query("DELETE FROM authority_effect_intents WHERE org_id = $1", [ORG_ID]);
    await ownerPool.query("DELETE FROM authority_decisions WHERE org_id = $1", [ORG_ID]);
    await ownerPool.query("DELETE FROM projects WHERE org_id = $1", [ORG_ID]);
    await ownerPool.query("DELETE FROM organizations WHERE id = $1", [ORG_ID]);
    await seedTenant(ownerPool);
  });

  function buildAuthority(): MergeAuthorityV2Impl {
    const host = new InMemoryCodeHost();
    host.seed(REPO, CONF_ENVELOPE.target.intoMain, CONF_ENVELOPE.expectedMainSha);
    const store = buildAuthorityLandStore(ownerPool, landContext(), new DirectRunStateWriter(ownerPool));
    return new MergeAuthorityV2Impl(host, new SubjectEqualityRevalidator(), store);
  }

  async function deliveryRows(): Promise<
    Array<{ id: string; authority_decision_id: string; merge_sha: string; status: string }>
  > {
    const res = await runWithOrgScope(ownerPool, ORG_ID, (client) =>
      client.query<{ id: string; authority_decision_id: string; merge_sha: string; status: string }>(
        "SELECT id, authority_decision_id, merge_sha, status FROM delivery_runs WHERE org_id = $1 ORDER BY id",
        [ORG_ID],
      ),
    );
    return res.rows;
  }

  async function mergeCompletedCount(): Promise<number> {
    const res = await ownerPool.query(
      "SELECT count(*)::int AS n FROM events WHERE run_id = $1 AND event_type = 'merge.completed'",
      [RUN_ID],
    );
    return res.rows[0]?.n ?? -1;
  }

  async function specStatus(): Promise<string | undefined> {
    const res = await runWithOrgScope(ownerPool, ORG_ID, (client) =>
      client.query<{ status: string }>("SELECT status FROM specs WHERE spec_id = $1", [SPEC_ID]),
    );
    return res.rows[0]?.status;
  }

  it("POSITIVE: an authorized land writes merge.completed AND exactly one delivery_runs row in one txn, bound to the merge SHA + decision", async () => {
    const authority = buildAuthority();
    const auth = await authority.authorizeLand(confAllClearInput(), CONF_ENVELOPE);
    const outcome = await authority.land(auth);
    expect(outcome.kind).toBe("landed");

    // Land record present (same transaction).
    expect(await mergeCompletedCount()).toBe(1);
    expect(await specStatus()).toBe("merged");

    // Exactly ONE outbox row, bound to the authorizing decision + the merge SHA.
    const rows = await deliveryRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.authority_decision_id).toBe(DECISION_ID);
    expect(rows[0]!.id).toBe(`delivery-${DECISION_ID}`);
    expect(rows[0]!.merge_sha.length).toBeGreaterThan(0);
    expect(rows[0]!.status).toBe("pending");
  });

  it("ATOMICITY (negative control): a finalize whose delivery FK cannot resolve rolls back the WHOLE record — no merge.completed, no spec flip, no half-written outbox row", async () => {
    // Drive `applyFinalizeLand` directly with an authorityDecisionId that has NO
    // authority_decisions row — the delivery_runs FK INSERT throws. Because the append,
    // the spec flip, and the outbox INSERT share ONE transaction, the throw ROLLS BACK
    // all three: this is exactly the "durable write failed after the external land"
    // reconcile case, and it must leave NOTHING half-written.
    await expect(
      runWithOrgScope(ownerPool, ORG_ID, (client) =>
        applyFinalizeLand(client, finalizeInput({ authorityDecisionId: "decision-does-not-exist" })),
      ),
    ).rejects.toThrow(/foreign key/u);

    expect(await mergeCompletedCount()).toBe(0);
    expect(await specStatus()).toBe("in_flight");
    expect(await deliveryRows()).toHaveLength(0);
  });

  it("IDEMPOTENCY: a merge.completed replay is a no-op — one event and one outbox row", async () => {
    // First land persists the decision row + the outbox row.
    const authority = buildAuthority();
    const auth = await authority.authorizeLand(confAllClearInput(), CONF_ENVELOPE);
    await authority.land(auth);
    const first = await deliveryRows();
    expect(first).toHaveLength(1);

    // A `merge_state_unknown` reconcile retry re-runs the SAME finalize applier.
    // The locked `merged` spec is the once-only gate, so this cannot append a second
    // terminal event or re-apply any land side effect.
    await runWithOrgScope(ownerPool, ORG_ID, (client) =>
      applyFinalizeLand(client, finalizeInput({ mergeSha: first[0]!.merge_sha })),
    );

    const after = await deliveryRows();
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(first[0]!.id);
    expect(await mergeCompletedCount()).toBe(1);
  });
});
