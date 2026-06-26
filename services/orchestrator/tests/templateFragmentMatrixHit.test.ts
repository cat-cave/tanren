// MATRIX-HIT ROUTING — INTEGRATION TESTS (PR-C).
//
// Pins the wiring at the live decision point — `selectSeedTemplate`. The CURATED
// registry is consulted FIRST; on a hit the function returns the new
// `compose-from-fragments` decision (the agent template-build path is skipped). On
// a miss the function falls through to the org-template-registry path that PR-B
// already shipped; double-miss flows through the existing fail-closed creation seam.
//
// FAKES ARE FIXTURES (the registry query + the create-for-no-match are injected
// callbacks, the SAME pattern PR-B's tests use); the curated registry itself is
// the LIVE catalog under test.

import { describe, expect, it } from "vitest";
import {
  PROOF_FRESHNESS_MS,
  SEEDABLE_STATUSES,
  selectSeedTemplate,
  TemplateRegistryQueryRequiredError,
  type SelectedTemplate,
  type TemplateRegistryQuery,
} from "../src/engine/forge/interview/index.js";
import type { CaptureLifecycle } from "../src/engine/forge/interview/types.js";
import type { Template } from "../src/engine/repositories/templates.js";

const NOW = Date.parse("2026-06-26T00:00:00.000Z");

// Two captured-lifecycle fixtures: one whose stack hits the curated registry,
// one that misses.
const MATRIX_HIT_LIFECYCLE: CaptureLifecycle = {
  stack: "ts/pnpm + React Router + Prisma + PostgreSQL on Fly.io",
  bootstrap: "pnpm install --frozen-lockfile",
  tier1: "pnpm lint && pnpm typecheck",
  tier2: "pnpm test -- --reporter=junit --outputFile=reports/junit.xml",
  tier3: "pnpm build",
  build: "pnpm build",
  deploy: "flyctl deploy",
  toolchain: [],
};

const NO_MATRIX_HIT_LIFECYCLE: CaptureLifecycle = {
  stack: "python/uv + FastAPI on Render",
  bootstrap: "uv sync",
  tier1: "ruff check",
  tier2: "pytest --junitxml=reports/junit.xml",
  tier3: "pytest",
  build: "uv build",
  deploy: "render deploy",
  toolchain: [],
};

function freshTemplate(id: string): Template {
  return {
    id,
    orgId: "org_a",
    repoRef: `cat-cave/${id}`,
    status: "validated",
    channel: "lts",
    manifest: {
      version: 1,
      stack: id,
      channel: "lts",
      templateVersion: "1.0.0",
      provenance: { researchSources: ["https://example.test"] },
      capabilities: {
        runtime: "python",
        packageManager: "uv",
        framework: "fastapi",
        deployTarget: "render",
        gates: ["tier-1", "tier-2", "tier-3"],
        bdd: true,
        mutation: true,
        junit: true,
      },
      validationProof: {
        positiveControlsPassed: true,
        negativeControls: { typecheck: "proven", lint: "proven", test: "proven", mutation: "proven" },
        auditorClean: true,
        validatedAt: new Date(NOW - PROOF_FRESHNESS_MS / 2).toISOString(),
        validatedSha: "feed1234",
      },
    },
  };
}

const noOpRegistry: TemplateRegistryQuery = async () => [];

describe("selectSeedTemplate — matrix-hit routes to compose-from-fragments", () => {
  it("a curated stack short-circuits BEFORE the registry query runs", async () => {
    let registryCalled = false;
    const registryQuery: TemplateRegistryQuery = async () => {
      registryCalled = true;
      return [];
    };
    const decision = await selectSeedTemplate({
      scaffoldOrigin: "project",
      lifecycle: MATRIX_HIT_LIFECYCLE,
      templateRegistryQuery: registryQuery,
      selectionNow: NOW,
    });
    expect(decision?.kind).toBe("compose-from-fragments");
    expect(decision?.curated?.id).toBe("ts-node-pnpm-react-router-prisma-postgres-fly");
    expect(decision?.reasons).toContain("matrix-hit:ts-node-pnpm-react-router-prisma-postgres-fly");
    // The registry was NOT consulted — matrix-hit short-circuits.
    expect(registryCalled).toBe(false);
    // The decision still records a (minimal) capability query for observability.
    expect(decision?.query.statuses).toEqual([...SEEDABLE_STATUSES]);
  });

  it("the curated lookup is canonicalized — cosmetic differences still hit", async () => {
    const cosmetic: CaptureLifecycle = {
      ...MATRIX_HIT_LIFECYCLE,
      stack: "  TS / PNPM + React-Router + Prisma + PostgreSQL on FLY.IO  ",
    };
    const decision = await selectSeedTemplate({
      scaffoldOrigin: "project",
      lifecycle: cosmetic,
      templateRegistryQuery: noOpRegistry,
      selectionNow: NOW,
    });
    expect(decision?.kind).toBe("compose-from-fragments");
    expect(decision?.curated?.id).toBe("ts-node-pnpm-react-router-prisma-postgres-fly");
  });

  it("matrix-hit works even WITHOUT a templateRegistryQuery (the lookup is the first thing)", async () => {
    // PR-C's intended behavior: the matrix-hit lookup is the first thing — a
    // curated hit does not need a registry query at all. (The existing wiring guard
    // only trips after the matrix check, on a miss.)
    const decision = await selectSeedTemplate({
      scaffoldOrigin: "project",
      lifecycle: MATRIX_HIT_LIFECYCLE,
      selectionNow: NOW,
    });
    expect(decision?.kind).toBe("compose-from-fragments");
  });
});

describe("selectSeedTemplate — matrix-MISS falls through to the org-registry path", () => {
  it("a non-curated stack with a matching org template returns the existing strong seed", async () => {
    const template = freshTemplate("python_uv_fastapi");
    const decision = await selectSeedTemplate({
      scaffoldOrigin: "project",
      lifecycle: NO_MATRIX_HIT_LIFECYCLE,
      templateRegistryQuery: async () => [template],
      selectionNow: NOW,
    });
    // NOT compose-from-fragments — the registry hit took priority on the miss.
    expect(decision?.kind).toBe("strong");
    expect(decision?.selected?.templateRef).toBe("python_uv_fastapi");
    expect(decision?.curated).toBeUndefined();
  });

  it("a non-curated stack with NO registry query throws the wiring-bug error", async () => {
    // The existing PR-B behavior is preserved on a matrix-miss — a project derive
    // without a registry query is a wiring bug, never a from-scratch signal.
    await expect(
      selectSeedTemplate({
        scaffoldOrigin: "project",
        lifecycle: NO_MATRIX_HIT_LIFECYCLE,
        selectionNow: NOW,
      }),
    ).rejects.toThrow(TemplateRegistryQueryRequiredError);
  });

  it("a non-curated stack with an EMPTY registry + a creation seam triggers JIT creation", async () => {
    const created: SelectedTemplate = {
      templateRef: "tmpl_jit",
      repoRef: "cat-cave/tmpl-jit",
      validationProof: freshTemplate("anything").manifest.validationProof!,
    };
    const decision = await selectSeedTemplate({
      scaffoldOrigin: "project",
      lifecycle: NO_MATRIX_HIT_LIFECYCLE,
      templateRegistryQuery: noOpRegistry,
      createTemplateForNoMatch: async () => created,
      selectionNow: NOW,
    });
    // Strong (created), the existing PR-B path; matrix-hit did not trigger.
    expect(decision?.kind).toBe("strong");
    expect(decision?.selected?.templateRef).toBe("tmpl_jit");
  });
});

describe("selectSeedTemplate — template_build origin SKIPS the matrix check", () => {
  it("a curated stack on template_build does NOT short-circuit (templates author from scratch)", async () => {
    const decision = await selectSeedTemplate({
      scaffoldOrigin: "template_build",
      lifecycle: MATRIX_HIT_LIFECYCLE,
      // No registryQuery (template_build forbids one — and a curated hit would be
      // wrong anyway since template_build is itself the template-authoring step).
    });
    // template_build returns undefined (the authoring IS the from-scratch work).
    expect(decision).toBeUndefined();
  });

  it("a curated stack on template_build with a registry query throws (template_build forbids it)", async () => {
    await expect(
      selectSeedTemplate({
        scaffoldOrigin: "template_build",
        lifecycle: MATRIX_HIT_LIFECYCLE,
        templateRegistryQuery: noOpRegistry,
      }),
    ).rejects.toThrow(/template_build scaffoldOrigin must not be given a templateRegistryQuery/u);
  });
});
