// The PgProductVisionReader: loads the product vision (personas / persona-
// behaviors / design-DNA) for a project + the two conflicting specs, RLS-scoped
// read-only. Over a FAKE QueryClient that routes on the SQL fragments the persona/
// behavior/project stores emit (test fixtures — they live HERE, never src/; the
// full RLS scoping is integration-tested live). Proves:
//   - personas load via listForProject, with `surface` read off the persona
//     `metadata` jsonb (where the derive persists it — no `surface` column);
//   - behaviors load for BOTH conflicting specs, de-duped + attributed to their
//     persona, with the BDD `then` mapped to `thenOutcome`;
//   - design-DNA loads off `projects.config.productVision` (pitch — designDna);
//   - a genuinely EMPTY product (no personas/behaviors/vision) returns an empty
//     vision (isProductVisionEmpty), never an error / stub;
//   - no resolved org ⇒ an empty vision (no wrong-scope read).

import type pg from "pg";
import { describe, expect, it } from "vitest";
import { isProductVisionEmpty } from "../src/engine/contracts/conflictResolution.js";
import { PgProductVisionReader } from "../src/engine/workflow/reviewMerge/conflictResolver/productVision.js";

const ORG = "org_1";
const PROJECT = "proj_1";
const MERGING = "spec_merging";
const BASE = "spec_base";

interface Seed {
  personas?: Array<{ id: string; name: string; description: string; surface?: string }>;
  behaviorsBySpec?: Record<string, Array<{ id: string; personaId: string; title: string; thenOutcome: string }>>;
  projectConfig?: unknown;
}

/** A fake client routing on the SQL the persona/behavior/project stores emit. */
function fakeClient(seed: Seed): Pick<pg.Pool, "query"> {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: (async (sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> => {
      const text = sql.replaceAll(/\s+/gu, " ").trim();
      if (text.includes("FROM personas")) {
        const rows = (seed.personas ?? []).map((p) => ({
          id: p.id,
          scope: "project",
          org_id: ORG,
          project_id: PROJECT,
          name: p.name,
          description: p.description,
          metadata: p.surface === undefined ? {} : { surface: p.surface },
          created_at: new Date(),
          updated_at: new Date(),
        }));
        return { rows };
      }
      if (text.includes("FROM behaviors b") && text.includes("spec_behaviors")) {
        const specId = String((params ?? [])[0]);
        const rows = (seed.behaviorsBySpec?.[specId] ?? []).map((b) => ({
          id: b.id,
          persona_id: b.personaId,
          title: b.title,
          given: "g",
          when: "w",
          // eslint-disable-next-line unicorn/no-thenable
          then: b.thenOutcome,
          description: null,
          metadata: {},
          created_at: new Date(),
          updated_at: new Date(),
        }));
        return { rows };
      }
      if (text.includes("FROM projects")) {
        return {
          rows: [
            {
              project_id: PROJECT,
              name: "p",
              repo_url: "https://github.com/o/r",
              default_branch: "main",
              runner_image: "img",
              allocator: "local",
              config: seed.projectConfig ?? { version: 1 },
              org_id: ORG,
              lifecycle: "active",
            },
          ],
        };
      }
      throw new Error(`unexpected SQL: ${text}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any,
  };
}

describe("PgProductVisionReader", () => {
  it("loads personas (with surface from metadata), both specs' behaviors, and design-DNA", async () => {
    const reader = new PgProductVisionReader({
      client: fakeClient({
        personas: [
          { id: "persona_shopper", name: "Shopper", description: "Buys fast", surface: "handheld" },
          { id: "persona_admin", name: "Admin", description: "Reviews orders" },
        ],
        behaviorsBySpec: {
          [MERGING]: [{ id: "b1", personaId: "persona_shopper", title: "One-tap", thenOutcome: "placed immediately" }],
          [BASE]: [{ id: "b2", personaId: "persona_admin", title: "Review", thenOutcome: "held for review" }],
        },
        projectConfig: { version: 1, productVision: { pitch: "Frictionless", designDna: "one tap everywhere" } },
      }),
      orgId: ORG,
    });

    const vision = await reader.read({ projectId: PROJECT, mergingSpecId: MERGING, conflictingSpecId: BASE });

    expect(isProductVisionEmpty(vision)).toBe(false);
    expect(vision.personas).toEqual([
      { name: "Shopper", description: "Buys fast", surface: "handheld" },
      { name: "Admin", description: "Reviews orders" },
    ]);
    // Behaviors from BOTH specs, attributed to their persona, then → thenOutcome.
    expect(vision.behaviors).toHaveLength(2);
    expect(vision.behaviors[0]).toMatchObject({
      persona: "Shopper",
      title: "One-tap",
      thenOutcome: "placed immediately",
    });
    expect(vision.behaviors[1]).toMatchObject({ persona: "Admin", title: "Review", thenOutcome: "held for review" });
    expect(vision.designDna).toBe("Frictionless — one tap everywhere");
  });

  it("de-dupes a behavior linked to BOTH conflicting specs", async () => {
    const shared = [{ id: "bShared", personaId: "persona_shopper", title: "Shared", thenOutcome: "x" }];
    const reader = new PgProductVisionReader({
      client: fakeClient({
        personas: [{ id: "persona_shopper", name: "Shopper", description: "d" }],
        behaviorsBySpec: { [MERGING]: shared, [BASE]: shared },
        projectConfig: { version: 1 },
      }),
      orgId: ORG,
    });
    const vision = await reader.read({ projectId: PROJECT, mergingSpecId: MERGING, conflictingSpecId: BASE });
    expect(vision.behaviors).toHaveLength(1);
  });

  it("returns an EMPTY vision for a genuinely empty product (no personas/behaviors/design-DNA) — not an error", async () => {
    const reader = new PgProductVisionReader({
      client: fakeClient({ projectConfig: { version: 1 } }),
      orgId: ORG,
    });
    const vision = await reader.read({ projectId: PROJECT, mergingSpecId: MERGING, conflictingSpecId: BASE });
    expect(isProductVisionEmpty(vision)).toBe(true);
    expect(vision.personas).toEqual([]);
    expect(vision.behaviors).toEqual([]);
    expect(vision.designDna).toBeUndefined();
  });

  it("handles an un-attributed conflict (no conflicting spec) — reads only the merging spec's behaviors", async () => {
    const reader = new PgProductVisionReader({
      client: fakeClient({
        personas: [{ id: "persona_shopper", name: "Shopper", description: "d" }],
        behaviorsBySpec: {
          [MERGING]: [{ id: "b1", personaId: "persona_shopper", title: "One-tap", thenOutcome: "x" }],
        },
        projectConfig: { version: 1 },
      }),
      orgId: ORG,
    });
    const vision = await reader.read({ projectId: PROJECT, mergingSpecId: MERGING });
    expect(vision.behaviors).toHaveLength(1);
  });

  it("returns an empty vision when no org is resolved (no wrong-scope read)", async () => {
    let queried = false;
    const reader = new PgProductVisionReader({
      client: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        query: (async () => {
          queried = true;
          return { rows: [] };
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
      },
    });
    const vision = await reader.read({ projectId: PROJECT, mergingSpecId: MERGING, conflictingSpecId: BASE });
    expect(isProductVisionEmpty(vision)).toBe(true);
    expect(queried).toBe(false);
  });
});
