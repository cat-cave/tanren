// ds-7 — the real F2D authoring helper over a fake fragment-store pool. A
// contract with no desired surfaces has no fragments to author, which must
// return an honest empty result without touching an Answerer or Postgres.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import { authorMissingFragments } from "../src/engine/design/system/composeAuthoring.js";

async function emptyFragmentQuery(): Promise<{ rows: unknown[] }> {
  return { rows: [] };
}

function fragmentReadPool(): pg.Pool {
  return { connect: async () => ({ query: emptyFragmentQuery, release() {} }) } as unknown as pg.Pool;
}

describe("authorMissingFragments — DB-free empty composition need", () => {
  it("returns empty ids and digests when the real V2 contract has no desired surfaces", async () => {
    await expect(
      authorMissingFragments(
        {
          pool: fragmentReadPool(),
          artifactStore: {} as never,
          fragmentAnswerer: {} as never,
          eventStore: {} as never,
          createdBy: "test",
        },
        {
          orgId: "org_ds7",
          projectId: "project_ds7",
          contractV2: {
            version: 2,
            domain: "game",
            identity: "empty fragment need",
            intent: "no surfaces require F2D output",
            principles: [],
            constraints: [],
            personaRefs: [],
            behaviorRefs: [],
            dimensions: [],
            desiredSurfaces: [],
            targetProfiles: [],
            accessibilityPosture: { standard: "none", notes: "" },
            exportRequirements: [],
            acceptanceIntent: "",
            visualVerification: { enabled: false, imageDiffThreshold: 0.01 },
          },
        },
      ),
    ).resolves.toEqual({ authoredIds: [], authoredFragmentDigests: [] });
  });
});
