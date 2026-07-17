// Conformance for the forge/recovery `Repositories` seam members migrated off
// the inline `.query` sites: discovery (specs.metadata + grounding list),
// recovery (run read, captured-commit reads, spec reopen writes), forge-tools
// (access-gate reads + the `tanren.read_*` projections + the project loads),
// inbox (source CRUD + the cross-org enabled-org fan-out), and audits (the job
// lifecycle + the cross-org org fan-out). Asserts the data-access contract
// through the public store API + observable state only, and — crucially — that a
// read on an org-scoped client sees that org's rows while an OFF-scope client
// sees ZERO (the RLS row-visibility gate the seam carries through). Drives the
// pg-backed stores against an in-memory pg target that models that visibility
// (forgeRecoveryMemoryDb.ts), the same way repositories.conformance.test.ts does
// for the product-entity stores.

import { describe, expect, it } from "vitest";
import { pgRepositories, type QueryClient } from "../../src/engine/contracts/repositories.js";
import { systemActor } from "../../src/engine/state/actor.js";
import { ForgeRecoveryDb, forgeRecoveryClientForOrg } from "./forgeRecoveryMemoryDb.js";

const ORG_A = "org_a";
const ORG_B = "org_b";
const repos = pgRepositories;
function db(): ForgeRecoveryDb {
  return new ForgeRecoveryDb();
}
function clientA(d: ForgeRecoveryDb): QueryClient {
  return forgeRecoveryClientForOrg(d, ORG_A);
}
function clientB(d: ForgeRecoveryDb): QueryClient {
  return forgeRecoveryClientForOrg(d, ORG_B);
}

// An `IngestedItem` shape for the candidate upsert conformance cases.
const item = (externalId: string, projectId: string | null) =>
  ({ externalId, title: "T", body: "B", severity: "info", projectId }) as const;
function seedSpec(d: ForgeRecoveryDb, over: Partial<ForgeRecoveryDb["specs"][number]> = {}): void {
  d.specs.push({
    spec_id: "spec_a",
    project_id: "project_a",
    title: "Spec A",
    description: "desc",
    status: "in_flight",
    metadata: null,
    org_id: ORG_A,
    ...over,
  });
}

describe("Repositories conformance: forge/recovery (in-memory pg)", () => {
  describe("discovery", () => {
    it("reads/writes spec metadata on the caller's client; missing → not found", async () => {
      const d = db();
      seedSpec(d, { metadata: { existing: 1 } });
      const got = await repos.discovery.getSpecMetadata(clientA(d), "spec_a", systemActor);
      expect(got).toEqual({ found: true, metadata: { existing: 1 } });
      const ok = await repos.discovery.setSpecMetadata(
        clientA(d),
        "spec_a",
        JSON.stringify({ existing: 1, discovery: { x: 1 } }),
        systemActor,
      );
      expect(ok).toBe(true);
      const after = await repos.discovery.getSpecMetadata(clientA(d), "spec_a", systemActor);
      expect(after).toEqual({ found: true, metadata: { existing: 1, discovery: { x: 1 } } });
      expect(await repos.discovery.getSpecMetadata(clientA(d), "spec_missing", systemActor)).toEqual({ found: false });
      expect(await repos.discovery.setSpecMetadata(clientA(d), "spec_missing", "{}", systemActor)).toBe(false);
    });
    it("lists existing specs bounded: active (non-terminal) first, then by recency (§7.5)", async () => {
      const d = db();
      // Insertion order: an old merged, a newer merged, then an active in_flight.
      seedSpec(d, { spec_id: "s_old", title: "Zeta", status: "merged" });
      seedSpec(d, { spec_id: "s_new", title: "Beta", status: "merged" });
      seedSpec(d, { spec_id: "s_active", title: "Alpha", status: "in_flight" });
      const rows = await repos.discovery.listExistingSpecs(clientA(d), "project_a", systemActor);
      // Active first; then terminal specs most-recent (insertion order) first — NOT
      // title-ordered (Alpha leads because it is active, not because of its title).
      expect(rows).toEqual([
        { specId: "s_active", title: "Alpha", status: "in_flight" },
        { specId: "s_new", title: "Beta", status: "merged" },
        { specId: "s_old", title: "Zeta", status: "merged" },
      ]);
    });
    it("scopes metadata + list reads to the org (off-scope sees zero)", async () => {
      const d = db();
      seedSpec(d, { metadata: { x: 1 } });
      expect(await repos.discovery.getSpecMetadata(clientB(d), "spec_a", systemActor)).toEqual({ found: false });
      expect(await repos.discovery.listExistingSpecs(clientB(d), "project_a", systemActor)).toHaveLength(0);
      // An off-scope metadata write matches no visible row → no update.
      expect(await repos.discovery.setSpecMetadata(clientB(d), "spec_a", "{}", systemActor)).toBe(false);
    });
  });
  describe("recovery", () => {
    function seedRun(d: ForgeRecoveryDb): void {
      d.runs.push({
        run_id: "run_a",
        spec_id: "spec_a",
        project_id: "project_a",
        status: "halted",
        outcome: "halted",
        org_id: ORG_A,
      });
    }
    function seedCaptured(d: ForgeRecoveryDb, id: number, ts: Date, sha: string): void {
      d.events.push({
        id,
        ts,
        run_id: "run_a",
        event_type: "workspace.git_captured",
        payload: { commits: [{ sha }] },
        org_id: ORG_A,
      });
    }

    it("reads a run's recovery fields; missing → undefined", async () => {
      const d = db();
      seedRun(d);
      expect(await repos.recovery.getRun(clientA(d), "run_a", systemActor)).toEqual({
        specId: "spec_a",
        projectId: "project_a",
        status: "halted",
        outcome: "halted",
      });
      expect(await repos.recovery.getRun(clientA(d), "run_missing", systemActor)).toBeUndefined();
    });

    it("returns the most-recent + all captured-commit payloads (ts DESC, id DESC)", async () => {
      const d = db();
      seedRun(d);
      seedCaptured(d, 1, new Date("2026-03-01T00:00:00Z"), "old");
      seedCaptured(d, 2, new Date("2026-03-02T00:00:00Z"), "new");
      const last = (await repos.recovery.getLastCapturedEventPayload(clientA(d), "run_a", systemActor)) as {
        commits: Array<{ sha: string }>;
      };
      expect(last.commits[0]!.sha).toBe("new");
      const all = await repos.recovery.listCapturedEventPayloads(clientA(d), "run_a", systemActor);
      expect(all).toHaveLength(2);
    });

    it("appends steering + reopens a non-terminal spec on the caller's client", async () => {
      const d = db();
      seedSpec(d);
      await repos.recovery.appendSteeringToSpec(clientA(d), "spec_a", "go left", systemActor);
      expect(d.specs[0]!.description).toContain("[operator steering] go left");
      await repos.recovery.reopenSpecForReplan(clientA(d), "spec_a", systemActor);
      expect(d.specs[0]!.status).toBe("open");
    });

    it("leaves terminal specs untouched on reopen", async () => {
      const d = db();
      seedSpec(d, { status: "merged" });
      await repos.recovery.reopenSpecForReplan(clientA(d), "spec_a", systemActor);
      expect(d.specs[0]!.status).toBe("merged");
    });

    it("scopes the run + captured reads + spec writes to the org (off-scope sees zero)", async () => {
      const d = db();
      seedRun(d);
      seedSpec(d);
      seedCaptured(d, 1, new Date("2026-03-01T00:00:00Z"), "x");
      expect(await repos.recovery.getRun(clientB(d), "run_a", systemActor)).toBeUndefined();
      expect(await repos.recovery.getLastCapturedEventPayload(clientB(d), "run_a", systemActor)).toBeUndefined();
      expect(await repos.recovery.listCapturedEventPayloads(clientB(d), "run_a", systemActor)).toHaveLength(0);
      // An off-scope reopen matches no visible spec → no status change.
      await repos.recovery.reopenSpecForReplan(clientB(d), "spec_a", systemActor);
      expect(d.specs[0]!.status).toBe("in_flight");
    });
  });

  describe("forgeTools", () => {
    function seedProject(d: ForgeRecoveryDb): void {
      d.projects.push({
        project_id: "project_a",
        repo_url: "https://example.com/a.git",
        runner_image: "img",
        config: { githubCredentialRef: "ref" },
        org_id: ORG_A,
      });
    }
    function seedRun(d: ForgeRecoveryDb): void {
      d.runs.push({
        run_id: "run_a",
        spec_id: "spec_a",
        project_id: "project_a",
        status: "running",
        outcome: null,
        org_id: ORG_A,
      });
    }

    it("reads the access-gate columns (project org, member count, run, spec)", async () => {
      const d = db();
      seedProject(d);
      seedRun(d);
      seedSpec(d);
      d.members.push({ project_id: "project_a", user_id: "u1", role: "admin", org_id: ORG_A });
      expect(await repos.forgeTools.getProjectOrgId(clientA(d), "project_a", systemActor)).toBe(ORG_A);
      expect(await repos.forgeTools.countProjectMemberRole(clientA(d), "project_a", "u1", systemActor)).toBe(1);
      expect(await repos.forgeTools.countProjectMemberRole(clientA(d), "project_a", "u2", systemActor)).toBe(0);
      expect(await repos.forgeTools.getRunProjectAndSpec(clientA(d), "run_a", systemActor)).toEqual({
        projectId: "project_a",
        specId: "spec_a",
      });
      expect(await repos.forgeTools.getSpecProjectId(clientA(d), "spec_a", systemActor)).toBe("project_a");
    });

    it("reads the full spec/run rows + ordered tasks + rerun spec id", async () => {
      const d = db();
      seedRun(d);
      seedSpec(d);
      d.tasks.push({ task_id: "t2", run_id: "run_a", started_at: null, org_id: ORG_A });
      d.tasks.push({ task_id: "t1", run_id: "run_a", started_at: null, org_id: ORG_A });
      expect((await repos.forgeTools.getSpecRow(clientA(d), "spec_a", systemActor))?.spec_id).toBe("spec_a");
      expect((await repos.forgeTools.getRunRow(clientA(d), "run_a", systemActor))?.run_id).toBe("run_a");
      const tasks = await repos.forgeTools.listRunTasks(clientA(d), "run_a", systemActor);
      expect(tasks.map((t) => t["task_id"])).toEqual(["t1", "t2"]);
      expect(await repos.forgeTools.getSpecIdForTask(clientA(d), "t1", systemActor)).toBe("spec_a");
    });

    it("reads project repo/config + runner context", async () => {
      const d = db();
      seedProject(d);
      expect(await repos.forgeTools.getProjectRepoAndConfig(clientA(d), "project_a", systemActor)).toEqual({
        repoUrl: "https://example.com/a.git",
        defaultBranch: "main",
        config: { githubCredentialRef: "ref" },
      });
      expect(await repos.forgeTools.getProjectRunnerContext(clientA(d), "project_a", systemActor)).toEqual({
        runnerImage: "img",
        config: { githubCredentialRef: "ref" },
        orgId: ORG_A,
      });
    });

    it("lists project personas + their behaviors ordered by title", async () => {
      const d = db();
      seedProject(d);
      d.personas.push({ id: "p_org", scope: "org", project_id: null, org_id: ORG_A });
      d.personas.push({ id: "p_proj", scope: "project", project_id: "project_a", org_id: ORG_A });
      d.behaviors.push({ id: "b2", persona_id: "p_org", title: "Beta", org_id: ORG_A });
      d.behaviors.push({ id: "b1", persona_id: "p_proj", title: "Alpha", org_id: ORG_A });
      const personaIds = await repos.forgeTools.listProjectPersonaIds(clientA(d), "project_a", systemActor);
      expect(personaIds.sort()).toEqual(["p_org", "p_proj"]);
      const behaviors = await repos.forgeTools.listBehaviorsForPersonas(clientA(d), personaIds, systemActor);
      expect(behaviors.map((b) => b["title"])).toEqual(["Alpha", "Beta"]);
    });

    it("lists the no-filter event + cost projections", async () => {
      const d = db();
      d.events.push({
        id: 1,
        ts: new Date("2026-03-01T00:00:00Z"),
        run_id: "run_a",
        event_type: "run.started",
        payload: { a: 1 },
        org_id: ORG_A,
      });
      d.costRecords.push({
        id: 1,
        run_id: "run_a",
        project_id: "project_a",
        cost_usd: "0.5",
        recorded_at: new Date("2026-03-01T00:00:00Z"),
        org_id: ORG_A,
      });
      const events = await repos.forgeTools.listEventsForTool(clientA(d), "", 1, [500], systemActor);
      expect(events).toHaveLength(1);
      const costs = await repos.forgeTools.listCostsForTool(clientA(d), "", [], systemActor);
      expect(costs).toHaveLength(1);
    });

    it("scopes every gate/read to the org (off-scope sees zero)", async () => {
      const d = db();
      seedProject(d);
      seedRun(d);
      seedSpec(d);
      d.members.push({ project_id: "project_a", user_id: "u1", role: "admin", org_id: ORG_A });
      expect(await repos.forgeTools.getProjectOrgId(clientB(d), "project_a", systemActor)).toBeNull();
      expect(await repos.forgeTools.countProjectMemberRole(clientB(d), "project_a", "u1", systemActor)).toBe(0);
      expect(await repos.forgeTools.getRunProjectAndSpec(clientB(d), "run_a", systemActor)).toBeUndefined();
      expect(await repos.forgeTools.getSpecProjectId(clientB(d), "spec_a", systemActor)).toBeUndefined();
      expect(await repos.forgeTools.getSpecRow(clientB(d), "spec_a", systemActor)).toBeUndefined();
      expect(await repos.forgeTools.getRunRow(clientB(d), "run_a", systemActor)).toBeUndefined();
      expect(await repos.forgeTools.getProjectRepoAndConfig(clientB(d), "project_a", systemActor)).toBeUndefined();
      expect(await repos.forgeTools.getProjectRunnerContext(clientB(d), "project_a", systemActor)).toBeUndefined();
    });
  });

  describe("inbox", () => {
    const seedSource = (d: ForgeRecoveryDb, projectId: string | null) =>
      repos.inbox.createSource(clientA(d), { orgId: ORG_A, projectId, kind: "manual", name: "S" });

    it("creates + reads sources on the caller's client; cross-org fan-out is system-scoped", async () => {
      const d = db();
      const created = await repos.inbox.createSource(clientA(d), {
        orgId: ORG_A,
        projectId: "project_a",
        kind: "manual",
        name: "S",
      });
      expect(created.orgId).toBe(ORG_A);
      expect(await repos.inbox.listSources(clientA(d), ORG_A)).toHaveLength(1);
      expect((await repos.inbox.getSource(clientA(d), created.id))?.id).toBe(created.id);
      // The cross-org poller fan-out: every org with an enabled source.
      expect(await repos.inbox.listDistinctEnabledSourceOrgIds(clientA(d))).toEqual([ORG_A]);
    });

    it("scopes source reads to the org (off-scope sees zero)", async () => {
      const d = db();
      const created = await repos.inbox.createSource(clientA(d), {
        orgId: ORG_A,
        projectId: null,
        kind: "manual",
        name: "S",
      });
      expect(await repos.inbox.listSources(clientB(d), ORG_A)).toHaveLength(0);
      expect(await repos.inbox.getSource(clientB(d), created.id)).toBeUndefined();
      expect(await repos.inbox.listDistinctEnabledSourceOrgIds(clientB(d))).toHaveLength(0);
    });

    it("upserts candidates idempotently (refresh, not duplicate) + reads them on the caller's client", async () => {
      const d = db();
      const source = await seedSource(d, "project_a");
      const first = await repos.inbox.upsertCandidate(clientA(d), source, item("ext-1", "project_a"), null, "new");
      expect(first.sourceName).toBe("S");
      expect(first.sourceKind).toBe("manual");
      // Re-upserting the SAME (source, externalId) refreshes content, never duplicates.
      const refreshed = await repos.inbox.upsertCandidate(
        clientA(d),
        source,
        { ...item("ext-1", "project_a"), title: "T2" },
        null,
        "triaged",
      );
      expect(refreshed.id).toBe(first.id);
      expect(refreshed.title).toBe("T2");
      expect(refreshed.status).toBe("triaged");
      expect(await repos.inbox.listCandidates(clientA(d), ORG_A)).toHaveLength(1);
      expect((await repos.inbox.getCandidate(clientA(d), first.id))?.id).toBe(first.id);
    });

    it("places a project + resolves a candidate to a terminal status on the caller's client", async () => {
      const d = db();
      const source = await seedSource(d, null);
      const cand = await repos.inbox.upsertCandidate(clientA(d), source, item("ext-1", null), null, "new");
      const placed = await repos.inbox.placeCandidateProject(clientA(d), cand.id, "project_a");
      expect(placed?.projectId).toBe("project_a");
      const resolved = await repos.inbox.resolveCandidate(clientA(d), cand.id, "accepted", "spec_x");
      expect(resolved?.status).toBe("accepted");
      expect(resolved?.resolvedSpecId).toBe("spec_x");
    });

    it("lists stuck auto-routed candidates (auto_routed + no resolved spec), oldest-update first", async () => {
      const d = db();
      const source = await seedSource(d, "project_a");
      // One stuck (auto_routed, unresolved), one resolved (auto_routed → accepted).
      await repos.inbox.upsertCandidate(clientA(d), source, item("stuck", "project_a"), null, "auto_routed");
      const done = await repos.inbox.upsertCandidate(
        clientA(d),
        source,
        item("done", "project_a"),
        null,
        "auto_routed",
      );
      await repos.inbox.resolveCandidate(clientA(d), done.id, "accepted", "spec_done");
      const stuck = await repos.inbox.listStuckAutoRouted(clientA(d), 10);
      expect(stuck.map((c) => c.externalId)).toEqual(["stuck"]);
    });

    it("scopes candidate reads/writes to the org (off-scope sees zero)", async () => {
      const d = db();
      const source = await seedSource(d, "project_a");
      const cand = await repos.inbox.upsertCandidate(
        clientA(d),
        source,
        item("ext-1", "project_a"),
        null,
        "auto_routed",
      );
      // Org B sees ZERO of org A's candidates — the RLS row-visibility gate.
      expect(await repos.inbox.listCandidates(clientB(d), ORG_A)).toHaveLength(0);
      expect(await repos.inbox.getCandidate(clientB(d), cand.id)).toBeUndefined();
      expect(await repos.inbox.placeCandidateProject(clientB(d), cand.id, "project_b")).toBeUndefined();
      expect(await repos.inbox.resolveCandidate(clientB(d), cand.id, "accepted", "spec_x")).toBeUndefined();
      expect(await repos.inbox.listStuckAutoRouted(clientB(d), 10)).toHaveLength(0);
    });
  });

  it("sourceSyncOutbox requires an authority decision, records receipt/readback, and verifies the returned row", async () => {
    const d = db();
    await expect(
      repos.sourceSyncOutbox.enqueue(clientA(d), {
        orgId: ORG_A,
        issueLoopId: "loop_a",
        sourceId: "src_a",
        operation: "close",
        payload: {},
        resolutionDecisionId: "rdec_rejected",
      }),
    ).rejects.toThrow("authorized ResolutionAuthority decision");
    const queued = await repos.sourceSyncOutbox.enqueue(clientA(d), {
      orgId: ORG_A,
      issueLoopId: "loop_a",
      sourceId: "src_a",
      operation: "close",
      payload: {},
      resolutionDecisionId: "rdec_authorized",
    });
    const claim = (workerId: string) =>
      repos.sourceSyncOutbox.claim(clientA(d), { orgId: ORG_A, id: queued.id, workerId, leaseMs: 60_000 });
    expect(await claim("worker_a")).toMatchObject({ id: queued.id, state: "pending", claimOwner: "worker_a" });
    expect(await claim("worker_b")).toBeUndefined();
    d.sourceSyncOutbox[0]!.claim_expires_at = new Date(0).toISOString();
    expect(await claim("worker_b")).toMatchObject({ id: queued.id, state: "pending", claimOwner: "worker_b" });
    d.sourceSyncOutbox[0]!.claim_expires_at = new Date(0).toISOString();
    expect(
      await repos.sourceSyncOutbox.claimNext(clientA(d), { orgId: ORG_A, workerId: "worker_c", leaseMs: 60_000 }),
    ).toMatchObject({ id: queued.id, claimOwner: "worker_c" });
    const sent = await repos.sourceSyncOutbox.beginAttempt(clientA(d), {
      orgId: ORG_A,
      id: queued.id,
      workerId: "worker_c",
    });
    expect(sent).toMatchObject({ state: "sent", attempt: 1 });
    expect(
      await repos.sourceSyncOutbox.recordProviderReceipt(clientA(d), {
        orgId: ORG_A,
        id: queued.id,
        workerId: "worker_c",
        receipt: { providerRevision: "revision_a" },
      }),
    ).toBe(true);
    expect(
      await repos.sourceSyncOutbox.markVerified(clientA(d), {
        orgId: ORG_A,
        id: queued.id,
        workerId: "worker_c",
        readback: { providerRevision: "revision_a", desiredState: "closed" },
      }),
    ).toBe(true);
    expect(await repos.sourceSyncOutbox.listRunnable(clientA(d), 10)).toEqual([]);
  });
  describe("audits", () => {
    it("creates, reads, toggles, and records a job on the caller's client; cross-org fan-out", async () => {
      const d = db();
      const job = await repos.audits.createAuditJob(clientA(d), {
        orgId: ORG_A,
        projectId: null,
        kind: "security",
        name: "A",
        cadence: "nightly",
      });
      expect(job.orgId).toBe(ORG_A);
      expect(await repos.audits.listAuditJobs(clientA(d), ORG_A)).toHaveLength(1);
      expect((await repos.audits.getAuditJob(clientA(d), job.id))?.id).toBe(job.id);
      const toggled = await repos.audits.setAuditJobEnabled(clientA(d), job.id, false);
      expect(toggled?.enabled).toBe(false);
      const recorded = await repos.audits.recordAuditRun(
        clientA(d),
        job.id,
        { count: 0, severity: "ok", note: "" },
        new Date("2026-03-03T00:00:00Z"),
      );
      expect(recorded?.lastRun).not.toBeNull();
      expect(await repos.audits.listDistinctAuditJobOrgIds(clientA(d))).toEqual([ORG_A]);
    });

    it("scopes job reads/writes to the org (off-scope sees zero)", async () => {
      const d = db();
      const job = await repos.audits.createAuditJob(clientA(d), {
        orgId: ORG_A,
        projectId: null,
        kind: "security",
        name: "A",
        cadence: "nightly",
      });
      expect(await repos.audits.listAuditJobs(clientB(d), ORG_A)).toHaveLength(0);
      expect(await repos.audits.getAuditJob(clientB(d), job.id)).toBeUndefined();
      expect(await repos.audits.setAuditJobEnabled(clientB(d), job.id, false)).toBeUndefined();
      expect(await repos.audits.listDistinctAuditJobOrgIds(clientB(d))).toHaveLength(0);
    });
  });
});
