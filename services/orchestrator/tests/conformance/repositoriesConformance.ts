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
import type { Repositories, QueryClient } from "../../src/engine/contracts/repositories.js";
import { systemActor } from "../../src/engine/state/actor.js";

export interface SeedProject {
  projectId: string;
  name: string;
  repoUrl: string;
  defaultBranch: string;
  runnerImage: string;
  allocator: string;
  config: unknown;
  orgId: string | null;
}

export interface RepositoriesConformanceHarness {
  repositories: Repositories;
  /** Seed the backing store with projects before the assertions run. */
  seed(data: { projects: SeedProject[] }): Promise<void> | void;
  /**
   * A client scoped to `orgId`. Reads through it must see ONLY that org's rows
   * (and writes ride this client) — the RLS row-visibility contract the seam
   * carries through from the org-scoped transaction.
   */
  clientForOrg(orgId: string): QueryClient;
}

const ORG_A = "org_a";
const ORG_B = "org_b";

function projectA(): SeedProject {
  return {
    projectId: "project_a",
    name: "A",
    repoUrl: "https://example.com/a.git",
    defaultBranch: "main",
    runnerImage: "img",
    allocator: "local",
    config: { version: 1 },
    orgId: ORG_A,
  };
}

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

    it("reads back the config blob it wrote on the caller's client", async () => {
      const h = await makeHarness();
      await h.seed({ projects: [projectA()] });
      const client = h.clientForOrg(ORG_A);
      await h.repositories.projects.updateConfig(
        client,
        "project_a",
        { version: 1, governancePosture: "x" },
        systemActor,
      );
      const config = await h.repositories.projects.getConfig(client, "project_a", systemActor);
      expect(config).toMatchObject({ governancePosture: "x" });
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
  });
}
