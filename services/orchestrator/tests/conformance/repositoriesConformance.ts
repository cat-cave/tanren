// Reusable behavior spec for the `Repositories` seam (engine/contracts/
// repositories.ts), mirroring the SecretStore/EventStore conformance suites.
// Asserts the data-access contract through the public store API and observable
// state only:
//   - reads decode rows to the typed contract shape,
//   - filters are honored (org-scoped lists),
//   - a missing row yields `undefined` (not a throw),
//   - writes run on the SAME client the caller hands in (the org-scope carrier),
//     and never widen scope — i.e. a read on an org-scoped client sees that
//     org's rows; a read on the wrong (off-scope) client sees ZERO rows.
//
// The seam takes a `QueryClient` per call, so the harness supplies a backing
// "database" plus a factory for org-scoped clients over it. The pg invocation
// drives this with an in-memory `pg` query target; under real RLS the same
// contract holds because the org-scoped client carries `app.current_org_id`.
import { describe, expect, it } from "vitest";
import { systemActor } from "../../src/engine/state/actor.js";
import {
  adminActor,
  ORG_A,
  ORG_B,
  projectA,
  type RepositoriesConformanceHarness,
  specA,
} from "./conformanceFixtures.js";
import { describeRunReadConformance } from "./runReadConformance.js";

export function describeRepositoriesConformance(
  label: string,
  makeHarness: () => RepositoriesConformanceHarness | Promise<RepositoriesConformanceHarness>,
): void {
  describe(`Repositories conformance: ${label}`, () => {
    it("lists projects for an org, decoded to the contract shape", async () => {
      const h = await makeHarness();
      await h.seed({ projects: [projectA()] });
      const rows = await h.repositories.projects.listForOrg(h.clientForOrg(ORG_A), ORG_A, systemActor);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ projectId: "project_a", name: "A", orgId: ORG_A });
    });

    it("returns undefined for a missing project (no throw)", async () => {
      const h = await makeHarness();
      await h.seed({ projects: [] });
      const row = await h.repositories.projects.get(h.clientForOrg(ORG_A), "project_missing", systemActor);
      expect(row).toBeUndefined();
    });

    it("reports project org id for the tenant gate", async () => {
      const h = await makeHarness();
      await h.seed({ projects: [projectA()] });
      const orgId = await h.repositories.projects.getOrgId(h.clientForOrg(ORG_A), "project_a", systemActor);
      expect(orgId).toBe(ORG_A);
    });

    it("reports project ownership (org id + default branch) for the full-track gate", async () => {
      const h = await makeHarness();
      await h.seed({ projects: [projectA()] });
      const ownership = await h.repositories.projects.getOwnership(h.clientForOrg(ORG_A), "project_a", systemActor);
      expect(ownership).toEqual({ orgId: ORG_A, defaultBranch: "main" });
    });

    it("reads back the config blob it wrote via revision CAS on the caller's client", async () => {
      const h = await makeHarness();
      await h.seed({ projects: [projectA()] });
      const client = h.clientForOrg(ORG_A);
      const snapshot = await h.repositories.projects.getConfigSnapshot(client, "project_a", systemActor);
      expect(snapshot?.revision).toBe("1");
      const outcome = await h.repositories.projects.compareAndSwapConfig(
        client,
        "project_a",
        "1",
        { version: 1, governancePosture: "x" },
        systemActor,
      );
      expect(outcome).toMatchObject({ status: "ok", revision: "2" });
      const config = await h.repositories.projects.getConfig(client, "project_a", systemActor);
      expect(config).toMatchObject({ governancePosture: "x" });
    });

    it("returns conflict (not success) when two writers race the same revision", async () => {
      const h = await makeHarness();
      await h.seed({ projects: [projectA()] });
      const client = h.clientForOrg(ORG_A);
      const first = await h.repositories.projects.compareAndSwapConfig(
        client,
        "project_a",
        "1",
        { version: 1, governancePosture: "winner" },
        systemActor,
      );
      expect(first).toMatchObject({ status: "ok", revision: "2" });
      const second = await h.repositories.projects.compareAndSwapConfig(
        client,
        "project_a",
        "1",
        { version: 1, governancePosture: "loser" },
        systemActor,
      );
      expect(second).toMatchObject({
        status: "conflict",
        current: { revision: "2", config: { governancePosture: "winner" } },
      });
    });

    it("updates a project's repo url on the caller's client", async () => {
      const h = await makeHarness();
      await h.seed({ projects: [projectA()] });
      const client = h.clientForOrg(ORG_A);
      await h.repositories.projects.updateRepoUrl(client, "project_a", "https://example.com/new.git", systemActor);
      const row = await h.repositories.projects.get(client, "project_a", systemActor);
      expect(row?.repoUrl).toBe("https://example.com/new.git");
    });

    it("scopes reads to the org's rows (RLS: off-scope sees zero)", async () => {
      const h = await makeHarness();
      await h.seed({ projects: [projectA()] });
      // In-scope: org A sees its project.
      const inScope = await h.repositories.projects.listForOrg(h.clientForOrg(ORG_A), ORG_A, systemActor);
      expect(inScope).toHaveLength(1);
      // Off-scope: an org-B client querying for org A's project sees nothing —
      // the scoped client (a SET LOCAL app.current_org_id = org_b txn under RLS)
      // filters org A's rows out.
      const offScope = await h.repositories.projects.listForOrg(h.clientForOrg(ORG_B), ORG_A, systemActor);
      expect(offScope).toHaveLength(0);
      // The single-row get + org-id gate are scoped the same way.
      const offGet = await h.repositories.projects.get(h.clientForOrg(ORG_B), "project_a", systemActor);
      expect(offGet).toBeUndefined();
      const offOrgId = await h.repositories.projects.getOrgId(h.clientForOrg(ORG_B), "project_a", systemActor);
      expect(offOrgId).toBeUndefined();
    });

    it("lists project specs ordered, decoded to the route row shape", async () => {
      const h = await makeHarness();
      await h.seed({ projects: [projectA()], specs: [specA()] });
      const rows = await h.repositories.projectSpecs.listForProject(h.clientForOrg(ORG_A), "project_a", systemActor);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ spec_id: "spec_a", project_id: "project_a", status: "draft" });
    });

    it("returns undefined for a missing spec (no throw)", async () => {
      const h = await makeHarness();
      await h.seed({ projects: [projectA()], specs: [] });
      const row = await h.repositories.projectSpecs.get(h.clientForOrg(ORG_A), "spec_missing", systemActor);
      expect(row).toBeUndefined();
    });

    it("patches a spec on the caller's client, returning whether a row matched", async () => {
      const h = await makeHarness();
      await h.seed({ projects: [projectA()], specs: [specA()] });
      const client = h.clientForOrg(ORG_A);
      const ok = await h.repositories.projectSpecs.patch(
        client,
        "spec_a",
        { fragments: ["title = $1"], params: ["renamed"] },
        systemActor,
      );
      expect(ok).toBe(true);
      const row = await h.repositories.projectSpecs.get(client, "spec_a", systemActor);
      expect(row?.title).toBe("renamed");
      const missing = await h.repositories.projectSpecs.patch(
        client,
        "spec_missing",
        { fragments: ["title = $1"], params: ["x"] },
        systemActor,
      );
      expect(missing).toBe(false);
    });

    it("scopes spec reads/writes to the org (RLS: off-scope sees zero)", async () => {
      const h = await makeHarness();
      await h.seed({ projects: [projectA()], specs: [specA()] });
      const inScope = await h.repositories.projectSpecs.listForProject(h.clientForOrg(ORG_A), "project_a", systemActor);
      expect(inScope).toHaveLength(1);
      const offList = await h.repositories.projectSpecs.listForProject(h.clientForOrg(ORG_B), "project_a", systemActor);
      expect(offList).toHaveLength(0);
      const offGet = await h.repositories.projectSpecs.get(h.clientForOrg(ORG_B), "spec_a", systemActor);
      expect(offGet).toBeUndefined();
      // An off-scope PATCH matches no visible row, so it reports no update.
      const offPatch = await h.repositories.projectSpecs.patch(
        h.clientForOrg(ORG_B),
        "spec_a",
        { fragments: ["title = $1"], params: ["nope"] },
        systemActor,
      );
      expect(offPatch).toBe(false);
    });

    it("lists/decodes personas for an org and scopes off-scope reads to zero", async () => {
      const h = await makeHarness();
      await h.seed({
        projects: [projectA()],
        personas: [{ id: "persona_a", scope: "org", orgId: ORG_A, projectId: null, name: "Buyer", description: "d" }],
      });
      const rows = await h.repositories.personas.listForOrg(h.clientForOrg(ORG_A), ORG_A, adminActor);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: "persona_a", orgId: ORG_A, name: "Buyer" });
      const off = await h.repositories.personas.listForOrg(h.clientForOrg(ORG_B), ORG_A, adminActor);
      expect(off).toHaveLength(0);
      const missing = await h.repositories.personas.get(h.clientForOrg(ORG_A), "persona_missing", adminActor);
      expect(missing).toBeUndefined();
    });

    it("lists behaviors for a persona and scopes off-scope reads to zero", async () => {
      const h = await makeHarness();
      /* eslint-disable unicorn/no-thenable */
      // `then` is the persisted BDD Given/When/Then column name, not a Promise hook.
      await h.seed({
        projects: [projectA()],
        personas: [{ id: "persona_a", scope: "org", orgId: ORG_A, projectId: null, name: "Buyer", description: "d" }],
        behaviors: [
          { id: "behavior_a", personaId: "persona_a", title: "B", given: "g", when: "w", then: "t", description: null },
        ],
      });
      /* eslint-enable unicorn/no-thenable */
      const rows = await h.repositories.behaviors.listForPersona(h.clientForOrg(ORG_A), "persona_a", adminActor);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: "behavior_a", personaId: "persona_a", title: "B" });
      // Off-scope: the parent persona is invisible, so the store's persona gate
      // throws (it cannot address the persona) — the row is unreachable.
      await expect(
        h.repositories.behaviors.listForPersona(h.clientForOrg(ORG_B), "persona_a", adminActor),
      ).rejects.toThrow(/persona not found/u);
    });

    it("lists milestones for a project and scopes off-scope reads to zero", async () => {
      const h = await makeHarness();
      await h.seed({
        projects: [projectA()],
        milestones: [
          {
            id: "ms_a",
            projectId: "project_a",
            label: "M1",
            name: "Alpha",
            orderIndex: 0,
            status: "planned",
            orgId: ORG_A,
          },
        ],
      });
      const rows = await h.repositories.milestones.listForProject(h.clientForOrg(ORG_A), "project_a", adminActor);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: "ms_a", projectId: "project_a", name: "Alpha" });
      const off = await h.repositories.milestones.listForProject(h.clientForOrg(ORG_B), "project_a", adminActor);
      expect(off).toHaveLength(0);
      const missing = await h.repositories.milestones.get(h.clientForOrg(ORG_A), "ms_missing", adminActor);
      expect(missing).toBeUndefined();
    });

    it("lists spec dependency edges and scopes off-scope reads to zero", async () => {
      const h = await makeHarness();
      await h.seed({
        projects: [projectA()],
        specs: [specA()],
        specDependencies: [{ fromSpecId: "spec_a", toSpecId: "spec_b" }],
      });
      const rows = await h.repositories.specDependencies.listOutgoing(h.clientForOrg(ORG_A), "spec_a", adminActor);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ fromSpecId: "spec_a", toSpecId: "spec_b" });
      const off = await h.repositories.specDependencies.listOutgoing(h.clientForOrg(ORG_B), "spec_a", adminActor);
      expect(off).toHaveLength(0);
    });
  });

  // The run-detail / run-list / event / cost read projections (routes/runs
  // loaders) live in a sibling suite to keep each file under the line cap; they
  // share the same harness + fixtures.
  describeRunReadConformance(label, makeHarness);
}
