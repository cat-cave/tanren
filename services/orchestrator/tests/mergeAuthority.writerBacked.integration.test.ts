// The FROZEN MergeAuthority conformance truth table (tanren-owns-the-engine.md §0/§5)
// driven against the REAL writer-backed `LandFinalizer` over a REAL Postgres — the
// Wave-2 / S1 upgrade of the Wave-1 in-memory fake. Proving the SAME truth table is
// now TRANSACTIONAL: `land` records `merge.completed` + the spec `merged` flip in ONE
// org-scoped transaction, and a durable-write failure AFTER the external land
// reconciles to `merge_state_unknown` (never a silent inconsistency).
//
// PLUS the THREE audit-7 P0 REGRESSION LOCKS (named tests) — each closes a place
// "best-effort" leaked inward:
//   (a) a live merge with `mergeability:'unknown'` → `blocked` (was: merged);
//   (b) a durable-write failure AFTER the external land → `merge_state_unknown`
//       (was: a silent inconsistency, the external merge fired before the record);
//   (c) a `changes_requested` review at merge time → `needs_attention` (was: absorbed).
//
// Gated behind TANREN_RLS_DB_TEST=1 + a superuser DATABASE_URL (the same ephemeral-DB
// harness the RLS suites use). Wired into `just smoke` (real Postgres up).

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate, runWithOrgScope } from "@tanren/db";
import { InMemoryCodeHost } from "./conformance/fakes/inMemoryCodeHost.js";
import {
  CONF_ENVELOPE,
  confAllClearInput,
  describeMergeAuthorityConformance,
} from "./conformance/mergeAuthorityConformance.js";
import {
  MergeAuthorityV2Impl,
  SubjectEqualityRevalidator,
  type AuthorityLandStore,
} from "../src/engine/merge/mergeAuthorityV2Impl.js";
import { buildAuthorityLandStore, type LandFinalizeContext } from "../src/engine/merge/mergeAuthorityLandFinalizer.js";
import { DirectRunStateWriter } from "../src/engine/worker/directRunStateWriter.js";
import { resolveLandTimeSignals, resolveLandTimeFindings } from "../src/engine/merge/landSignals.js";
import { authorizeAndLand } from "../src/engine/merge/mergeAuthorityGate.js";
import { PgEventStore } from "../src/engine/eventStore.js";
import { serviceAuditActor } from "../src/engine/events/schemas/audit.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const REPO = { owner: "owner", name: "repo" };
const ORG_ID = "org_ma";
const PROJECT_ID = "proj_ma";
// The conformance envelope lands spec_a / run_a — seed those exact ids so the receipt's
// `merge.completed` (FK task) + spec `merged` flip hit real rows.
const SPEC_ID = CONF_ENVELOPE.members[0]!.specId;
const RUN_ID = CONF_ENVELOPE.members[0]!.runId;
const TASK_ID = "task_ma_merge";

function dbName(): string {
  return `tanren_ma_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** The finalize context the conformance node lands under (the merge-stage identity). */
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

describeDb("MergeAuthority — writer-backed LandFinalizer over real Postgres", () => {
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
    // Reset the tenant rows each case so the spec status / events start clean (a
    // prior absorb left spec `merged`). Truncate the run-scoped tables, re-seed.
    await ownerPool.query("DELETE FROM events WHERE org_id = $1", [ORG_ID]);
    await ownerPool.query("DELETE FROM tasks WHERE run_id = $1", [RUN_ID]);
    await ownerPool.query("DELETE FROM runs WHERE org_id = $1", [ORG_ID]);
    await ownerPool.query("DELETE FROM specs WHERE org_id = $1", [ORG_ID]);
    // in-16: a landed run now also writes a `delivery_runs` outbox row FK'd (ON DELETE
    // no action) to `authority_decisions` + `projects`. Delete it (and any bindings that
    // FK it) BEFORE the authority_decisions / projects deletes below, else those FKs fail.
    await ownerPool.query("DELETE FROM delivery_run_bindings WHERE org_id = $1", [ORG_ID]);
    await ownerPool.query("DELETE FROM delivery_runs WHERE org_id = $1", [ORG_ID]);
    // The V2 land writes authority_decisions → effect_intents → land_receipts (all
    // project_id-FK'd, ON DELETE no action per convention); delete them in FK order
    // before the project so the project delete does not hit the authority FK.
    await ownerPool.query("DELETE FROM authority_land_receipts WHERE org_id = $1", [ORG_ID]);
    await ownerPool.query("DELETE FROM authority_effect_intents WHERE org_id = $1", [ORG_ID]);
    await ownerPool.query("DELETE FROM authority_decisions WHERE org_id = $1", [ORG_ID]);
    await ownerPool.query("DELETE FROM projects WHERE org_id = $1", [ORG_ID]);
    await ownerPool.query("DELETE FROM organizations WHERE id = $1", [ORG_ID]);
    await seedTenant(ownerPool);
  });

  /** Build the writer-backed authority: in-memory host (CAS) + the REAL DB land store. */
  function buildAuthority(failFinalize: boolean): MergeAuthorityV2Impl {
    const host = new InMemoryCodeHost();
    host.seed(REPO, CONF_ENVELOPE.target.intoMain, CONF_ENVELOPE.expectedMainSha);
    // Audit D-R3.2: buildAuthorityLandStore requires the writer; the Direct writer over the
    // same owner pool runs the byte-identical `applyFinalizeLand` org-scoped transaction.
    const real = buildAuthorityLandStore(ownerPool, landContext(), new DirectRunStateWriter(ownerPool));
    // The failing variant wraps the real store in a throw-after-land receipt — a faithful
    // "the durable write failed AFTER the external land fired" (the reconcile case).
    const store: AuthorityLandStore = failFinalize
      ? {
          persistAuthorizedDecision: real.persistAuthorizedDecision.bind(real),
          recordLandReceipt: async () => {
            throw new Error("durable receipt failed");
          },
        }
      : real;
    return new MergeAuthorityV2Impl(host, new SubjectEqualityRevalidator(), store);
  }

  // Drive the FROZEN truth table against the writer-backed impl.
  describeMergeAuthorityConformance("MergeAuthorityV2Impl + writer-backed land store (real DB)", {
    make: () => buildAuthority(false),
    makeWithFailingFinalize: () => buildAuthority(true),
  });

  // ---- The 3 audit-7 P0 REGRESSION LOCKS (named) -----------------------------

  it("REGRESSION LOCK (P0-a): a live land with mergeability:'unknown' is BLOCKED (was: merged)", async () => {
    const authority = buildAuthority(false);
    const input = { ...confAllClearInput(), mergeability: "unknown" as const };
    const auth = await authority.authorizeLand(input, CONF_ENVELOPE);
    expect(auth.decision).toBe("blocked");
    // The spec was NEVER advanced to `merged` (no land happened).
    const status = await specStatus();
    expect(status).not.toBe("merged");
  });

  it("REGRESSION LOCK (P0-b): a durable-write failure AFTER the external land reconciles to merge_state_unknown (was: silent inconsistency)", async () => {
    const authority = buildAuthority(true);
    const auth = await authority.authorizeLand(confAllClearInput(), CONF_ENVELOPE);
    const outcome = await authority.land(auth);
    // NEVER a plain failure / silent inconsistency — the explicit reconcile state.
    expect(outcome.kind).toBe("merge_state_unknown");
    const reconcileToken = outcome.kind === "merge_state_unknown" ? outcome.reconcileToken : "";
    expect(reconcileToken).not.toBe("");
  });

  it("REGRESSION LOCK (P0-c): a changes_requested review at merge time routes to needs_attention (was: absorbed)", async () => {
    const authority = buildAuthority(false);
    const input = { ...confAllClearInput(), reviewVerdict: "changes_requested" as const };
    const auth = await authority.authorizeLand(input, CONF_ENVELOPE);
    expect(auth.decision).toBe("needs_attention");
    const status = await specStatus();
    expect(status).not.toBe("merged");
  });

  it("a fully-clear land lands transactionally + flips the spec to merged + records merge.completed", async () => {
    const authority = buildAuthority(false);
    const auth = await authority.authorizeLand(confAllClearInput(), CONF_ENVELOPE);
    const outcome = await authority.land(auth);
    expect(outcome.kind).toBe("landed");
    // The durable record landed in ONE transaction: spec merged + the merge.completed event.
    expect(await specStatus()).toBe("merged");
    const events = await ownerPool.query<{ event_type: string }>(
      "SELECT event_type FROM events WHERE run_id = $1 AND event_type = 'merge.completed'",
      [RUN_ID],
    );
    expect(events.rowCount).toBe(1);
  });

  // ---- FRESH LAND-TIME signals: resolveLandTimeSignals reads the LATEST, fail-closed ----

  it("resolveLandTimeSignals: no recorded verdict → both undefined (the authority blocks)", async () => {
    const signals = await resolveLandTimeSignals(ownerPool, ORG_ID, RUN_ID);
    expect(signals.gateOutcome).toBeUndefined();
    expect(signals.reviewVerdict).toBeUndefined();
  });

  it("resolveLandTimeSignals: returns the LATEST pre_merge gate (+ its gated sha) + review (a re-gate/flip wins)", async () => {
    // A passing gate for sha-A + approved review first, then a LATER failing re-gate +
    // a flipped changes_requested review (e.g. emitted DURING conflict resolution). The
    // reader must return the LATEST — the pre-conflict passing values are NOT used.
    await appendGateVerdict(true, "sha-A");
    await appendReview("review.approved");
    let signals = await resolveLandTimeSignals(ownerPool, ORG_ID, RUN_ID);
    expect(signals.gateOutcome?.passed).toBe(true);
    expect(signals.gatedHeadSha).toBe("sha-A");
    expect(signals.reviewVerdict).toBe("approved");

    // a re-gate that now FAILS + the review flipped to changes_requested.
    await appendGateVerdict(false, "sha-A");
    await appendReview("review.changes_requested");
    signals = await resolveLandTimeSignals(ownerPool, ORG_ID, RUN_ID);
    // The LATEST wins: a failing gate → undefined (blocks); changes_requested review.
    expect(signals.gateOutcome).toBeUndefined();
    expect(signals.reviewVerdict).toBe("changes_requested");
  });

  it("TOCTOU LOCK (DB): a fresh pre_merge gate PASSED for sha A, the head being landed is sha B → BLOCKED (commit-bound)", async () => {
    // The reader returns the gate's gatedHeadSha (sha-A) from the durable record.
    await appendGateVerdict(true, "sha-A");
    const signals = await resolveLandTimeSignals(ownerPool, ORG_ID, RUN_ID);
    expect(signals.gateOutcome?.passed).toBe(true);
    expect(signals.gatedHeadSha).toBe("sha-A");

    // Land sha-B (head advanced after the gate). The CodeHost reports the head as sha-B;
    // authorizeAndLand must BLOCK because the gate (sha-A) != the head being landed (sha-B).
    const host = new InMemoryCodeHost();
    host.seed(REPO, "main", "sha-main");
    await host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: "sha-B" });
    const disposition = await authorizeAndLand({
      codeHost: host,
      repo: REPO,
      intoMain: "main",
      headBranch: "feat",
      runId: RUN_ID,
      specId: SPEC_ID,
      gateConfigHash: "gc",
      policyVersion: "pv",
      gatedHeadSha: signals.gatedHeadSha,
      behaviorGate: { kind: "not_applicable" },
      store: {
        persistAuthorizedDecision: async () => ({ effectIntentId: "intent_1" }),
        recordLandReceipt: async () => ({ auditId: "a" }),
      },
      signals: {
        gateOutcome: signals.gateOutcome,
        findings: [],
        auditPosture: { blockReviewAt: "P1", p2p3Handling: "route-to-dag" },
        reviewVerdict: "approved",
        mergeability: { state: "clean", behind: false, baseBranch: "main", headBranch: "feat" },
        budget: { ceilingUsd: undefined, spentUsd: 0 },
        demo: "not_required",
        hitlSignoff: "not_required",
        conflictsResolved: true,
      },
    });
    expect(disposition.kind).toBe("blocked");
    // sha-B was never landed; main untouched.
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-main");
  });

  // ---- S3a: resolveLandTimeFindings — the LIVE audit gate, fail-closed on missing ----

  it("resolveLandTimeFindings: NO auditor.verdict recorded → a synthetic P0 (fail-closed, blocks any posture)", async () => {
    const findings = await resolveLandTimeFindings(ownerPool, ORG_ID, RUN_ID);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("P0");
    expect(findings[0]!.id).toContain("audit-record-missing");
  });

  it("resolveLandTimeFindings: an audited-CLEAN verdict (empty findings) → [] (the audit input clears)", async () => {
    await appendAuditorVerdict([]);
    const findings = await resolveLandTimeFindings(ownerPool, ORG_ID, RUN_ID);
    expect(findings).toEqual([]);
  });

  it("resolveLandTimeFindings: returns the EXPLICIT findings the auditor emitted (a P1 surfaces)", async () => {
    await appendAuditorVerdict([{ id: "f1", severity: "P1", title: "blocking", body: "b" }]);
    const findings = await resolveLandTimeFindings(ownerPool, ORG_ID, RUN_ID);
    expect(findings.map((f) => f.severity)).toEqual(["P1"]);
    expect(findings[0]!.id).toBe("f1");
  });

  /** Append an `auditor.verdict` carrying an explicit findings list. */
  async function appendAuditorVerdict(
    findings: ReadonlyArray<{ id: string; severity: "P0" | "P1" | "P2" | "P3"; title: string; body: string }>,
  ): Promise<void> {
    await runWithOrgScope(ownerPool, ORG_ID, (client) =>
      new PgEventStore(client).append({
        runId: RUN_ID,
        specId: SPEC_ID,
        projectId: PROJECT_ID,
        orgId: ORG_ID,
        eventType: "auditor.verdict",
        payload: {
          runId: RUN_ID,
          findings: [...findings],
        },
      }),
    );
  }

  /** Append a `pre_merge` gate.verdict with the given `passed` + gated `headSha`. */
  async function appendGateVerdict(passed: boolean, headSha: string): Promise<void> {
    await runWithOrgScope(ownerPool, ORG_ID, (client) =>
      new PgEventStore(client).append({
        runId: RUN_ID,
        specId: SPEC_ID,
        projectId: PROJECT_ID,
        orgId: ORG_ID,
        eventType: "gate.verdict",
        payload: { when: "pre_merge", headSha, passed, durationMs: 1, tiers: [], steps: [] },
      }),
    );
  }

  /** Append a review verdict event through the eventStore. */
  async function appendReview(eventType: "review.approved" | "review.changes_requested"): Promise<void> {
    await runWithOrgScope(ownerPool, ORG_ID, (client) =>
      new PgEventStore(client).append({
        runId: RUN_ID,
        specId: SPEC_ID,
        projectId: PROJECT_ID,
        orgId: ORG_ID,
        eventType,
        payload: { prUrl: "https://github.com/owner/repo/pull/1", prNumber: 1 },
      }),
    );
  }

  async function specStatus(): Promise<string | undefined> {
    const result = await runWithOrgScope(ownerPool, ORG_ID, (client) =>
      client.query<{ status: string }>("SELECT status FROM specs WHERE spec_id = $1", [SPEC_ID]),
    );
    return result.rows[0]?.status;
  }
});

/** Seed the org/project/spec/run/task the conformance node lands under (as owner). */
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
