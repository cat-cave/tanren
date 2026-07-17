import { describe, expect, it } from "vitest";
import type { EventStore } from "../src/engine/eventStore.js";
import { enforceRepositoryVisibilityOnClient } from "../src/engine/governance/repoVisibility.js";
import { RepositoryVisibilityObservationsStore } from "../src/engine/repositories/repositoryVisibilityObservations.js";
import { MemoryDb } from "./conformance/conformanceMemoryDb.js";
import { createRepositoryVisibilityConformanceClient } from "./conformance/repositoryVisibilityConformanceFake.js";

const ORG_A = "org_repo_visibility_a";
const ORG_B = "org_repo_visibility_b";
const PROJECT_A = "project_repo_visibility_a";
const PROJECT_B = "project_repo_visibility_b";

function seedProject(db: MemoryDb, orgId: string, projectId: string): void {
  db.seedProject({
    projectId,
    name: projectId,
    repoUrl: `https://github.com/example/${projectId}.git`,
    defaultBranch: "main",
    runnerImage: "runner:test",
    allocator: "local",
    config: { version: 1 },
    orgId,
  });
  const project = db.projects.find((row) => row.org_id === orgId && row.project_id === projectId);
  if (project === undefined) throw new Error(`failed to seed ${orgId}/${projectId}`);
  project.repo_visibility = "private";
}

describe("repository visibility observation conformance", () => {
  it("records matching and mismatching immutable attestations, events, and RLS isolation", async () => {
    const db = new MemoryDb();
    seedProject(db, ORG_A, PROJECT_A);
    seedProject(db, ORG_B, PROJECT_B);
    const clientA = createRepositoryVisibilityConformanceClient(db, ORG_A);
    const clientB = createRepositoryVisibilityConformanceClient(db, ORG_B);
    const events: Array<{ eventType: string; payload: unknown }> = [];
    const eventStore: Pick<EventStore, "append"> = {
      append: async (input) => {
        events.push({ eventType: input.eventType, payload: input.payload });
      },
    };

    const match = await enforceRepositoryVisibilityOnClient(clientA as never, eventStore, {
      orgId: ORG_A,
      projectId: PROJECT_A,
      observedVisibility: "private",
      forgeRef: "github:example/private-repo",
      sha: "match-sha",
    });
    expect(match.status).toBe("allowed");

    const mismatch = await enforceRepositoryVisibilityOnClient(clientA as never, eventStore, {
      orgId: ORG_A,
      projectId: PROJECT_A,
      observedVisibility: "public",
      forgeRef: "github:example/private-repo",
      sha: "mismatch-sha",
    });
    expect(mismatch.status).toBe("blocked");
    expect(mismatch.expectedVisibility).toBe("private");
    expect(events.map((event) => event.eventType)).toEqual([
      "repository.visibility.observed",
      "governance.visibility.enforced",
      "repository.visibility.observed",
      "repository.visibility.mismatch",
      "governance.visibility.enforced",
    ]);
    expect(events.find((event) => event.eventType === "repository.visibility.mismatch")?.payload).toMatchObject({
      expectedVisibility: "private",
      observedVisibility: "public",
    });

    const observations = await RepositoryVisibilityObservationsStore.list(clientA as never, ORG_A, PROJECT_A);
    expect(observations).toHaveLength(2);
    await expect(
      clientA.query(
        "UPDATE repository_visibility_observations SET observed_visibility = 'private' WHERE org_id = $1 AND observation_id = $2",
        [ORG_A, mismatch.observation.observationId],
      ),
    ).rejects.toThrow(/immutable/u);
    await expect(
      clientA.query("DELETE FROM repository_visibility_observations WHERE org_id = $1 AND observation_id = $2", [
        ORG_A,
        mismatch.observation.observationId,
      ]),
    ).rejects.toThrow(/immutable/u);

    expect(await RepositoryVisibilityObservationsStore.list(clientB as never, ORG_A, PROJECT_A)).toEqual([]);
  });
});
