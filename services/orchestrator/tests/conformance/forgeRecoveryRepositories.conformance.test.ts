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

    it("lists existing specs ordered by title", async () => {
      const d = db();
      seedSpec(d, { spec_id: "s2", title: "Beta", status: "draft" });
      seedSpec(d, { spec_id: "s1", title: "Alpha", status: "active" });
      const rows = await repos.discovery.listExistingSpecs(clientA(d), "project_a", systemActor);
      expect(rows).toEqual([
        { specId: "s1", title: "Alpha", status: "active" },
        { specId: "s2", title: "Beta", status: "draft" },
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
