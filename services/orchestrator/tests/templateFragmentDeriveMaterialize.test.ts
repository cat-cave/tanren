// DERIVE MATRIX-HIT MATERIALIZATION — INTEGRATION TEST (PR-C).
//
// Proves the end-to-end derive path under the matrix-hit decision: a project derive
// whose stack hits the curated registry calls the `materializeCuratedTemplate` seam
// (the wiring's GitHub compose + push), substitutes the seam's `SelectedTemplate`
// as a `strong` seed, and the scaffold spec uses the SEED path (NOT from-scratch,
// NOT the agent template-build).
//
// FAKES: the `materializeCuratedTemplate` seam is a stub that records the curated
// entry it was called with + returns a synthetic `SelectedTemplate` — the same
// pattern PR-B's `createTemplateForNoMatch` tests use for the JIT-creation seam.
// The in-memory pg.Pool stub is the shared derive fixture (`stubPool`).

/* eslint-disable unicorn/no-thenable */
// `then` is BDD Given/When/Then vocabulary in the capture fixtures.

import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import {
  deriveFromCapture,
  emptyCapture,
  type CaptureLifecycle,
  type InterviewCapture,
} from "../src/engine/forge/interview/index.js";
import type {
  CuratedTemplate,
  MaterializeCuratedInput,
  MaterializeCuratedTemplate,
} from "../src/engine/templates/index.js";
import type { SelectedTemplate } from "../src/engine/forge/interview/templateSelection.js";
import { preparedDeploy, stubPool } from "./fixtures/forge/interviewDeriveStub.js";

const actor: ActorContext = {
  userId: "user_a",
  orgId: "org_a",
  projectId: null,
  scopes: ["platform:admin"],
  source: "session",
};

const TEST_REPO_URL = "https://github.com/cat-cave/matrix-hit-product";

// The curated stack ("ts/pnpm + React Router + Prisma + PostgreSQL on Fly.io" is
// the registry's apex default — see registry/curated.ts).
const MATRIX_HIT_LIFECYCLE: CaptureLifecycle = {
  stack: "ts/pnpm + React Router + Prisma + PostgreSQL on Fly.io",
  bootstrap: "pnpm install --frozen-lockfile",
  tier1: "pnpm lint && pnpm typecheck",
  tier2: "pnpm test -- --reporter=junit --outputFile=reports/junit.xml",
  tier3: "pnpm lint && pnpm typecheck && pnpm build && pnpm test",
  build: "pnpm build",
  deploy: "flyctl deploy",
  toolchain: [],
};

const MINIMAL_DESIGN_CONTRACT = {
  domain: "saas-web",
  identity: "a clean, trustworthy operations surface",
  intent: "a calm, information-dense control surface an operator trusts at a glance",
  principles: [],
  constraints: [],
  personas: [],
  behaviors: [],
  dimensions: [],
};

function captureWithLifecycle(): InterviewCapture {
  return {
    ...emptyCapture(),
    lifecycle: MATRIX_HIT_LIFECYCLE,
    designContract: MINIMAL_DESIGN_CONTRACT,
  };
}

// Synthetic SelectedTemplate the materializer stub returns. Mirrors the shape the
// live wiring would produce after creating the template repo + pushing the VFS.
function syntheticSelected(curated: CuratedTemplate): SelectedTemplate {
  return {
    templateRef: `tanren://fragments/${curated.id}`,
    repoRef: `cat-cave/tanren-tmpl-${curated.id}`,
    validationProof: {
      positiveControlsPassed: true,
      negativeControls: { typecheck: "proven", lint: "proven", test: "proven", mutation: "proven" },
      auditorClean: true,
      validatedAt: "2026-06-26T00:00:00.000Z",
      validatedSha: "fragment-compose",
    },
  };
}

describe("derive — matrix-hit decision invokes the materializer + becomes a strong seed", () => {
  it("calls materializeCuratedTemplate with the curated entry + lifecycle + owner", async () => {
    const { pool } = stubPool();
    const calls: MaterializeCuratedInput[] = [];
    const materializer: MaterializeCuratedTemplate = async (input) => {
      calls.push(input);
      return syntheticSelected(input.curated);
    };
    const derived = await deriveFromCapture(
      {
        pool,
        async prepareDeploy(r) {
          return preparedDeploy(r.providerKind as "deploy.vercel" | "deploy.flyio");
        },
      },
      {
        orgId: "org_a",
        capture: captureWithLifecycle(),
        actor,
        owner: "cat-cave",
        repoUrl: TEST_REPO_URL,
        deploy: { providerKind: "deploy.flyio" },
        materializeCuratedTemplate: materializer,
        // NO templateRegistryQuery, NO createTemplateForNoMatch — the matrix-hit
        // path short-circuits before either is consulted.
      },
    );
    expect(calls.length).toBe(1);
    expect(calls[0]?.curated.id).toBe("ts-node-pnpm-react-router-prisma-postgres-fly");
    expect(calls[0]?.lifecycle.stack).toBe(MATRIX_HIT_LIFECYCLE.stack);
    expect(calls[0]?.owner).toBe("cat-cave");
    // The derive's surfaced selection is the STRONG seed (the materialized result),
    // preserving the matrix-hit + materialized provenance in `reasons`.
    expect(derived.templateSelection?.kind).toBe("strong");
    expect(derived.templateSelection?.selected?.templateRef).toBe(
      "tanren://fragments/ts-node-pnpm-react-router-prisma-postgres-fly",
    );
    expect(derived.templateSelection?.reasons).toContain("matrix-hit:ts-node-pnpm-react-router-prisma-postgres-fly");
    expect(derived.templateSelection?.reasons).toContain("materialized");
  });

  it("the scaffold spec is the SEED path (NOT from-scratch) when matrix-hit materialized", async () => {
    const { pool, state } = stubPool();
    const materializer: MaterializeCuratedTemplate = async (input) => syntheticSelected(input.curated);
    const derived = await deriveFromCapture(
      {
        pool,
        async prepareDeploy(r) {
          return preparedDeploy(r.providerKind as "deploy.vercel" | "deploy.flyio");
        },
      },
      {
        orgId: "org_a",
        capture: captureWithLifecycle(),
        actor,
        owner: "cat-cave",
        repoUrl: TEST_REPO_URL,
        deploy: { providerKind: "deploy.flyio" },
        materializeCuratedTemplate: materializer,
      },
    );
    const scaffold = state.specs.get(derived.specIds[0] ?? "");
    expect(scaffold?.title).toBe("scaffold");
    // The seed scaffold authoring (SEED FROM TEMPLATE) is used; the from-scratch
    // authoring (the long `Scaffold the actual PROJECT CODE` description) is NOT.
    expect(scaffold?.description).toContain("SEED FROM TEMPLATE");
    expect(scaffold?.description).toContain("tanren-tmpl-ts-node-pnpm-react-router-prisma-postgres-fly");
    expect(scaffold?.description).not.toContain("Scaffold the actual PROJECT CODE");
  });

  it("persists the materialized templateRef on the project config (audit + run seeding)", async () => {
    const { pool, configs } = stubPool();
    const materializer: MaterializeCuratedTemplate = async (input) => syntheticSelected(input.curated);
    const derived = await deriveFromCapture(
      {
        pool,
        async prepareDeploy(r) {
          return preparedDeploy(r.providerKind as "deploy.vercel" | "deploy.flyio");
        },
      },
      {
        orgId: "org_a",
        capture: captureWithLifecycle(),
        actor,
        owner: "cat-cave",
        repoUrl: TEST_REPO_URL,
        deploy: { providerKind: "deploy.flyio" },
        materializeCuratedTemplate: materializer,
      },
    );
    const config = configs.get(derived.projectId) as { templateRef?: { templateRef?: string; repoRef?: string } };
    expect(config?.templateRef?.templateRef).toBe("tanren://fragments/ts-node-pnpm-react-router-prisma-postgres-fly");
    expect(config?.templateRef?.repoRef).toBe("cat-cave/tanren-tmpl-ts-node-pnpm-react-router-prisma-postgres-fly");
  });

  it("a matrix-hit decision with NO materializer wired HALTS LOUD (wiring bug)", async () => {
    // The compose-from-fragments path REQUIRES a materializer; absent on a project
    // derive is a wiring failure that must surface clearly rather than silently
    // pass a not-yet-materialized decision into the scaffold spec authoring.
    const { pool, state } = stubPool();
    await expect(
      deriveFromCapture(
        {
          pool,
          async prepareDeploy(r) {
            return preparedDeploy(r.providerKind as "deploy.vercel" | "deploy.flyio");
          },
        },
        {
          orgId: "org_a",
          capture: captureWithLifecycle(),
          actor,
          owner: "cat-cave",
          repoUrl: TEST_REPO_URL,
          deploy: { providerKind: "deploy.flyio" },
          // materializeCuratedTemplate intentionally omitted.
        },
      ),
    ).rejects.toThrow(/materializeCuratedTemplate seam wired/u);
    // No project leaked through the halt.
    expect(state.projects.size).toBe(0);
  });
});
