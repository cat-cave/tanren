// THE NO-NON-TEMPLATE-DAG INVARIANT — proven END-TO-END through the greenfield derive
// (templating-system.md §3). The doctrine: every PROJECT DAG executes against a
// VALIDATED TEMPLATE, never a from-scratch scaffold. A match SEEDS; a no-match CREATES
// a template just-in-time + seeds from it; an un-creatable no-match HALTS LOUD
// (`TemplateRequiredError`); a project derive with no registry query is a wiring bug.
//
// Split out of visionInterview.test.ts (file-size discipline) — it shares the same
// in-memory derive stub. FAKES ARE TEST FIXTURES ONLY.

/* eslint-disable unicorn/no-thenable */
// `then` is BDD Given/When/Then vocabulary in the capture/behavior fixtures.

import { describe, expect, it, vi } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import type { Template as TemplateForTest } from "../src/engine/repositories/templates.js";
import {
  deriveFromCapture,
  emptyCapture,
  runRound,
  type CaptureLifecycle,
  type InterviewCapture,
} from "../src/engine/forge/interview/index.js";
import { createDeterministicInterviewAnswerer } from "./fixtures/forge/deterministicInterviewAnswerer.js";
import { preparedDeploy, stubPool, type StubState } from "./fixtures/forge/interviewDeriveStub.js";

const actor: ActorContext = {
  userId: "user_a",
  orgId: "org_a",
  projectId: null,
  scopes: ["platform:admin"],
  source: "session",
};

const TEST_REPO_URL = "https://github.com/cat-cave/supply-chain-os";
const WAVE3_NOW = Date.parse("2026-06-09T00:00:00.000Z");

const TS_LIFECYCLE: CaptureLifecycle = {
  stack: "ts/pnpm",
  bootstrap: "pnpm install --frozen-lockfile",
  tier1: "pnpm lint && pnpm typecheck",
  tier2: "pnpm build && pnpm test -- --reporter=junit --outputFile=reports/junit.xml",
  tier3: "pnpm lint && pnpm typecheck && pnpm build && pnpm test",
  build: "pnpm build",
  deploy: "flyctl deploy",
  toolchain: [],
};
const captureWithLifecycle = (): InterviewCapture => ({ ...emptyCapture(), lifecycle: TS_LIFECYCLE });

const validatedTsTemplate = (): TemplateForTest => ({
  id: "template_ts_next",
  orgId: "org_a",
  repoRef: "cat-cave/tanren-template-ts-next",
  status: "validated",
  channel: "lts",
  manifest: {
    version: 1,
    stack: "ts-pnpm-next",
    channel: "lts",
    templateVersion: "1.0.0",
    provenance: { researchSources: ["https://nextjs.org"] },
    capabilities: {
      runtime: "ts",
      packageManager: "pnpm",
      framework: "next",
      deployTarget: "flyctl",
      gates: ["tier-1", "tier-2", "tier-3"],
      bdd: true,
      mutation: true,
      junit: true,
    },
    validationProof: {
      positiveControlsPassed: true,
      negativeControls: { typecheck: "proven", lint: "proven", test: "proven", mutation: "proven" },
      auditorClean: true,
      validatedAt: "2026-06-01T00:00:00.000Z",
      validatedSha: "abc1234",
    },
  },
});

// Drive the full deterministic interview, then derive the product graph (the shared
// boilerplate). Defaults to the project-path SEED inputs (a matching template) unless
// the caller overrides — so a "project" derive always reaches a validated seed.
async function runInterviewAndDerive(overrides: Partial<Parameters<typeof deriveFromCapture>[1]> = {}): Promise<{
  derived: Awaited<ReturnType<typeof deriveFromCapture>>;
  state: StubState;
  configs: Map<string, Record<string, unknown>>;
}> {
  const { pool, state, configs } = stubPool();
  const answerer = createDeterministicInterviewAnswerer();
  let capture: InterviewCapture = emptyCapture();
  let complete = false;
  for (let round = 1; round <= 20 && !complete; round += 1) {
    const result = await runRound({ pool, answerer }, { round, answer: "ok", capture });
    capture = result.capture;
    complete = result.complete;
  }
  const defaults: Partial<Parameters<typeof deriveFromCapture>[1]> = {
    selectionNow: WAVE3_NOW,
    templateRegistryQuery: async () => [validatedTsTemplate()],
  };
  const derived = await deriveFromCapture(
    {
      pool,
      async prepareDeploy(request) {
        return preparedDeploy(request.providerKind as "deploy.vercel" | "deploy.flyio");
      },
    },
    {
      orgId: "org_a",
      capture,
      actor,
      repoUrl: TEST_REPO_URL,
      deploy: { providerKind: "deploy.vercel" },
      ...defaults,
      ...overrides,
    },
  );
  return { derived, state, configs };
}

// The Forge SELECTION integration (templating-system.md §3), proven END-TO-END
// through the derive under the DOCTRINE: every project DAG seeds from a VALIDATED
// template — never a from-scratch scaffold. A match seeds; a no-match CREATES a
// template just-in-time and seeds from it; an un-creatable no-match HALTS LOUD.
describe("template selection — the no-non-template-DAG invariant (templating-system.md §3)", () => {
  it("a matching validated template → SEED path: scaffold spec shrinks + templateRef persisted", async () => {
    const { derived, state, configs } = await runInterviewAndDerive({
      selectionNow: WAVE3_NOW,
      templateRegistryQuery: async () => [validatedTsTemplate()],
    });

    // The selection is recorded on the result + persisted on the project config.
    expect(derived.templateSelection?.kind).toBe("strong");
    expect(derived.templateSelection?.selected?.templateRef).toBe("template_ts_next");
    const config = configs.get(derived.projectId) as { templateRef?: { templateRef?: string; repoRef?: string } };
    expect(config?.templateRef?.templateRef).toBe("template_ts_next");
    expect(config?.templateRef?.repoRef).toBe("cat-cave/tanren-template-ts-next");

    // The scaffold spec SHRANK to template instantiation — NOT author-from-scratch.
    const scaffold = state.specs.get(derived.specIds[0] ?? "");
    expect(scaffold?.title).toBe("scaffold");
    expect(scaffold?.description).toContain("SEED FROM TEMPLATE");
    expect(scaffold?.description).toContain("cat-cave/tanren-template-ts-next");
    expect(scaffold?.description).not.toContain("Scaffold the actual PROJECT CODE");
  });

  it("a NO-MATCH with a creation seam → CREATES just-in-time + SEEDS (never from-scratch)", async () => {
    // Empty registry (no match) BUT a wired createTemplateForNoMatch that returns a
    // freshly-published template → the project SEEDS from it; the scaffold is the
    // seed authoring, NOT from-scratch.
    const created = {
      templateRef: "tmpl_jit",
      repoRef: "cat-cave/tanren-template-jit",
      validationProof: validatedTsTemplate().manifest.validationProof,
    };
    const { derived, state, configs } = await runInterviewAndDerive({
      templateRegistryQuery: async () => [],
      createTemplateForNoMatch: async () => created,
    });
    expect(derived.templateSelection?.kind).toBe("strong");
    expect(derived.templateSelection?.reasons).toContain("created");
    const config = configs.get(derived.projectId) as { templateRef?: { repoRef?: string } };
    expect(config?.templateRef?.repoRef).toBe("cat-cave/tanren-template-jit");
    const scaffold = state.specs.get(derived.specIds[0] ?? "");
    expect(scaffold?.description).toContain("SEED FROM TEMPLATE");
    expect(scaffold?.description).not.toContain("Scaffold the actual PROJECT CODE");
  });

  it("a NO-MATCH with NO creation seam → HALTS LOUD (no project from-scratch scaffold)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Empty registry + no creation seam ⇒ the derive must HALT (fail-closed), never
    // create a project whose scaffold is from-scratch. NOTHING is persisted.
    const { pool, state, configs } = stubPool();
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
          repoUrl: TEST_REPO_URL,
          deploy: { providerKind: "deploy.vercel" },
          templateRegistryQuery: async () => [],
        },
      ),
    ).rejects.toThrow(/no validated template matched|HALTING fail-closed/u);
    // No project / specs leaked through the halt.
    expect(state.projects.size).toBe(0);
    expect(state.specs.size).toBe(0);
    expect(configs.size).toBe(0);
    warn.mockRestore();
  });

  it("a NO-MATCH whose creation FAILS → HALTS LOUD (durable failure, not from-scratch)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
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
          repoUrl: TEST_REPO_URL,
          deploy: { providerKind: "deploy.vercel" },
          templateRegistryQuery: async () => [],
          createTemplateForNoMatch: async () => {
            throw new Error("creation failed: build did not converge");
          },
        },
      ),
    ).rejects.toThrow(/HALTING fail-closed|no validated template/u);
    expect(state.specs.size).toBe(0);
    warn.mockRestore();
  });

  it("a project derive with NO registry query is a WIRING BUG → throws (selection is never skipped)", async () => {
    // The deleted bypass: "registry query undefined ⇒ skip selection ⇒ from-scratch".
    // A project-origin derive ALWAYS runs selection; an absent registry query is a
    // LOUD wiring failure, not a from-scratch signal.
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
          repoUrl: TEST_REPO_URL,
          deploy: { providerKind: "deploy.vercel" },
          // No templateRegistryQuery, default scaffoldOrigin "project".
        },
      ),
    ).rejects.toThrow(/requires a template registry query|never scaffolds from-scratch/u);
    expect(state.projects.size).toBe(0);
  });
});
