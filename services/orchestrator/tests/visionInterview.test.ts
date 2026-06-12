// greenfield-onboarding engine tests.
//
// Exercises the interview round loop (with a MOCKED answerer — no provider is
// contacted — and the deterministic scripted fallback), the capture merge, and
// the derivation path (project + personas + behaviors + milestones + specs all
// created through the existing entity stores). The pool is a lightweight
// in-memory stub keyed by SQL substring, mirroring the discovery engine-test
// pattern. No migration is required — every row lands in an existing table.

/* eslint-disable unicorn/no-thenable */
// `then` is BDD Given/When/Then vocabulary in the capture/behavior fixtures.

import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import type { Template as TemplateForTest } from "../src/engine/repositories/templates.js";
import {
  DeployProviderMissingError,
  deriveFromCapture,
  emptyCapture,
  mergeCapture,
  MissingLifecycleError,
  runRound,
  type CaptureLifecycle,
  type InterviewAnswerer,
  type InterviewCapture,
} from "../src/engine/forge/interview/index.js";
import { createDeterministicInterviewAnswerer } from "./fixtures/forge/deterministicInterviewAnswerer.js";
import { preparedDeploy, stubPool, type StubState } from "./fixtures/forge/interviewDeriveStub.js";

// A TS/pnpm lifecycle capture (apex v27 default) — NOT a Tanren hardcode: the
// project DECLARES it; the scaffold authors the justfile from it.
const TS_LIFECYCLE: CaptureLifecycle = {
  stack: "ts/pnpm",
  // FRESH-REPO-SAFE BOOTSTRAP (apex v32): a from-scratch greenfield repo has no
  // lockfile, so the captured bootstrap is a plain non-frozen install (it generates
  // the lockfile the scaffold commits) — never `--frozen-lockfile`.
  bootstrap: "pnpm install",
  tier1: "pnpm lint && pnpm typecheck",
  tier2: "pnpm build && pnpm test -- --reporter=junit --outputFile=reports/junit.xml",
  tier3: "pnpm lint && pnpm typecheck && pnpm build && pnpm test",
  build: "pnpm build",
  deploy: "flyctl deploy",
  toolchain: [],
};

// A capture WITH the lifecycle (so a deploy-guard test isolates the deploy guard,
// not the earlier missing-lifecycle guard).
const captureWithLifecycle = (): InterviewCapture => ({ ...emptyCapture(), lifecycle: TS_LIFECYCLE });

// TEMPLATING WAVE 3 — a fixed clock + a fixture VALIDATED template (a matching
// TS/pnpm/next seed). At module scope so it is not recreated per test (lint).
const WAVE3_NOW = Date.parse("2026-06-09T00:00:00.000Z");
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

const actor: ActorContext = {
  userId: "user_a",
  orgId: "org_a",
  projectId: null,
  scopes: ["platform:admin"],
  source: "session",
};

const TEST_REPO_URL = "https://github.com/cat-cave/supply-chain-os";

// Drive the full deterministic interview to completion, then derive the product
// graph — the boilerplate every derive test shares. Returns the derive result + the
// in-memory state so callers can assert on the created specs/configs.
// DOCTRINE (templating-system.md §3): a PROJECT DAG ALWAYS seeds from a validated
// template — never a from-scratch scaffold. So the shared derive helper defaults to
// the SEED path (a matching validated template injected via the registry query). A
// test that needs the from-scratch AUTHORING (the legitimate one — the template-build
// step) passes `scaffoldOrigin: "template_build"` + omits the registry query.
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
  // Default project-path seed inputs (a matching template + a fixed clock) unless the
  // caller overrides them (e.g. a template_build run, or a no-match-creates run).
  const defaults: Partial<Parameters<typeof deriveFromCapture>[1]> =
    overrides.scaffoldOrigin === "template_build"
      ? {}
      : {
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

describe("runRound · interview round loop", () => {
  it("uses a mocked answerer and merges the returned capture delta", async () => {
    const { pool } = stubPool();
    let seenRound = 0;
    const answerer: InterviewAnswerer = {
      async ask(ctx) {
        seenRound = ctx.round;
        return {
          say: "who uses this?",
          captureDelta: {
            personas: [{ name: "ops manager", description: "runs orders", surface: "desktop" }],
          },
          suggestions: [],
          complete: false,
        };
      },
    };
    const result = await runRound(
      { pool, answerer },
      { round: 2, answer: "a supply chain tool", capture: emptyCapture() },
    );
    expect(seenRound).toBe(2);
    expect(result.say).toBe("who uses this?");
    expect(result.capture.personas).toHaveLength(1);
    expect(result.complete).toBe(false);
  });

  it("deterministic answerer accumulates the full capture across rounds and completes", async () => {
    const { pool } = stubPool();
    const answerer = createDeterministicInterviewAnswerer();
    let capture = emptyCapture();
    let complete = false;
    let round = 1;
    // Drive rounds until the script flips complete (bounded so a regression
    // cannot loop forever).
    for (; round <= 20 && !complete; round += 1) {
      const result = await runRound({ pool, answerer }, { round, answer: "ok", capture });
      capture = result.capture;
      complete = result.complete;
    }
    expect(complete).toBe(true);
    expect(capture.identity?.slug).toBe("supply-chain-os");
    expect(capture.personas.length).toBeGreaterThanOrEqual(3);
    expect(capture.behaviors.length).toBeGreaterThanOrEqual(5);
    expect(capture.interfaces.length).toBeGreaterThanOrEqual(2);
    expect(capture.rulesets.length).toBeGreaterThanOrEqual(3);
  });
});

describe("mergeCapture · monotonic union", () => {
  it("de-dupes personas/behaviors by key and last-write-wins on identity", () => {
    const base = mergeCapture(emptyCapture(), {
      identity: { slug: "a", pitch: "first", repoHint: "" },
      personas: [{ name: "ops", description: "x", surface: "" }],
    });
    const merged = mergeCapture(base, {
      identity: { slug: "a", pitch: "refined", repoHint: "" },
      personas: [
        { name: "ops", description: "y", surface: "desktop" },
        { name: "cfo", description: "z", surface: "" },
      ],
    });
    expect(merged.identity?.pitch).toBe("refined");
    expect(merged.personas).toHaveLength(2);
    expect(merged.personas.find((p) => p.name === "ops")?.surface).toBe("desktop");
  });
});

describe("deriveFromCapture · creates the product graph (no migration)", () => {
  it("derives project + personas + behaviors + milestones + specs through existing stores", async () => {
    const { derived, state } = await runInterviewAndDerive();

    expect(state.projects.size).toBe(1);
    expect(derived.projectName).toBe("supply-chain-os");
    // 3 personas, 7 behaviors, 3 scaffold + per-interface (schema + behaviors) specs.
    expect(derived.personaIds).toHaveLength(3);
    expect(derived.behaviorIds.length).toBeGreaterThanOrEqual(5);
    // M1 scaffold + one milestone per interface (>= 2 interfaces).
    expect(derived.milestoneIds.length).toBeGreaterThanOrEqual(3);
    // Every behavior spec is linked to a milestone + tied to its behavior.
    expect(state.specMilestones).toBe(derived.specIds.length);
    expect(state.specBehaviors).toBe(derived.behaviorIds.length);
    // The foundation is a serialized CHAIN, not parallel roots: only `scaffold` is a
    // root; every later spec carries a dep.
    const hasDeps = [...state.specs.values()].filter((s) => s.dependsOn.length > 0).length;
    expect(hasDeps).toBe(derived.specIds.length - 1);
  });

  it("derives a serialized scaffold CHAIN (build→scaffold, deploy→build), not parallel roots", async () => {
    const { derived, state } = await runInterviewAndDerive();
    // The scaffold specs are created first, in order: scaffold, build, deploy.
    const [scaffoldId, buildId, deployId] = derived.specIds;
    const [scaffold, build, deploy] = [scaffoldId, buildId, deployId].map((id) => state.specs.get(id));
    expect([scaffold?.title, build?.title, deploy?.title]).toEqual(["scaffold", "build", "deploy"]);
    // scaffold is the SOLE root; build depends on scaffold; deploy on build.
    expect(scaffold?.dependsOn).toEqual([]);
    expect(build?.dependsOn).toEqual([scaffoldId]);
    expect(deploy?.dependsOn).toEqual([buildId]);
  });

  it("derives scaffold/build/deploy FROM the captured lifecycle + PERSISTS the lifecycle for deterministic contract materialization", async () => {
    // v27 fix: the deterministic answerer captures a TS/pnpm lifecycle; the lifecycle
    // is PERSISTED on the project config so the RUN materializes the contract files
    // deterministically (no LLM authoring), and the scaffold spec's WRITER authors the
    // project CODE. build/deploy route through the conventional targets FROM the
    // captured lifecycle. (Multi-stack authoring is unit-tested in
    // scaffoldAuthoring.test.ts; the contract projection in contractFiles.test.ts.)
    //
    // The from-scratch AUTHORING is the template-BUILD step (the ONE legitimate
    // from-scratch path) — so this runs `scaffoldOrigin: "template_build"`.
    const { derived, state, configs } = await runInterviewAndDerive({
      scaffoldOrigin: "template_build",
    } as Partial<Parameters<typeof deriveFromCapture>[1]>);
    const [scaffold, build, deploy] = derived.specIds.map((id) => state.specs.get(id));

    // The lifecycle is persisted onto the project config (the run materializes from it).
    const config = configs.get(derived.projectId) as { lifecycle?: { stack?: string; bootstrap?: string } } | undefined;
    expect(config?.lifecycle?.stack).toBe("ts/pnpm");
    expect(config?.lifecycle?.bootstrap).toBe("pnpm install");

    const desc = scaffold?.description ?? "";
    // The writer is told the contract files are pre-committed (materialized).
    expect(desc.toLowerCase()).toMatch(/already committed|pre-committed|materialized/u);
    expect(desc).toContain("justfile");
    expect(desc).toContain(".tanren/ci.yml");
    // The captured TS/pnpm commands surface as CONTEXT; the ci.yml body is NEVER inlined.
    // The greenfield bootstrap is a fresh-repo-safe non-frozen install (apex v32).
    expect(desc).toContain("pnpm install");
    expect(desc).not.toContain("--frozen-lockfile");
    expect(desc).not.toContain("version: 1\nbootstrap:");
    // The green bar is bootstrap/tier-1/build — NOT the test tier.
    const criteria = scaffold?.acceptanceCriteria ?? [];
    expect(criteria.find((c) => /each exits 0|are green/u.test(c))).toContain("just bootstrap");
    expect(criteria.some((c) => /(just tier-2|just tier-3).*exits 0/u.test(c))).toBe(false);

    // build + deploy route through the conventional `just build` / `just deploy`.
    expect(build?.description).toContain("just build");
    expect(deploy?.description).toContain("just deploy");
    expect(deploy?.acceptanceCriteria.join("\n")).toContain("just deploy");
  });

  it("FAILS LOUD when the architecture step captured no lifecycle (never silently defaults to Node)", async () => {
    const { pool, state } = stubPool();
    // A deploy provider IS supplied — so the rejection is specifically the missing
    // lifecycle (the scaffold can't author a justfile without it), not the deploy guard.
    await expect(
      deriveFromCapture(
        { pool },
        {
          orgId: "org_a",
          capture: emptyCapture(),
          actor,
          repoUrl: TEST_REPO_URL,
          deploy: { providerKind: "deploy.vercel" },
        },
      ),
    ).rejects.toBeInstanceOf(MissingLifecycleError);
    expect(state.projects.size).toBe(0);
  });

  it('FINDING #1: autonomy:"auto" creates an autonomous project config (no follow-up PATCH)', async () => {
    const { pool, configs } = stubPool();
    const answerer = createDeterministicInterviewAnswerer();
    let capture: InterviewCapture = emptyCapture();
    let complete = false;
    for (let round = 1; round <= 20 && !complete; round += 1) {
      const result = await runRound({ pool, answerer }, { round, answer: "ok", capture });
      capture = result.capture;
      complete = result.complete;
    }
    const deployRequests: unknown[] = [];
    const derived = await deriveFromCapture(
      {
        pool,
        async prepareDeploy(request) {
          deployRequests.push(request);
          return preparedDeploy(request.providerKind);
        },
      },
      {
        orgId: "org_a",
        capture,
        actor,
        repoUrl: TEST_REPO_URL,
        autonomy: "auto",
        deploy: { providerKind: "deploy.vercel" },
        selectionNow: WAVE3_NOW,
        templateRegistryQuery: async () => [validatedTsTemplate()],
      },
    );

    const config = configs.get(derived.projectId);
    expect(config).toBeDefined();
    expect(config?.reviewPolicy).toBe("auto");
    expect(config?.mergeIntegration).toBe("native_queue");
    // The autonomous greenfield config is LENIENT (functional-but-weak apex
    // doctrine): the in-loop gate's lint/typecheck are advisory so an imperfect
    // first pass lands + improves via the issue loop instead of stalling.
    expect(config?.governancePosture).toBe("lenient");
    // The interview path always builds off an empty repo ⇒ greenfield (drives the
    // non-frozen in-loop deps-ensure).
    expect(config?.greenfield).toBe(true);
    expect(deployRequests).toEqual([
      expect.objectContaining({
        orgId: "org_a",
        capability: "deploy",
        providerKind: "deploy.vercel",
        mode: "greenfield",
        projectKey: "supply-chain-os",
        projectName: "supply-chain-os",
        name: "supply-chain-os",
      }),
    ]);
    expect(config?.deployProvider).toBe("deploy.vercel");
    expect(config?.deployAppId).toBe("app_1");
  });

  it("FINDING deploy: autonomous greenfield rejects missing deploy before project creation", async () => {
    const { pool, state } = stubPool();
    // A registry query is provided (a match) so the deploy guard — not the template
    // selection guard — is the rejection under test.
    await expect(
      deriveFromCapture(
        { pool },
        {
          orgId: "org_a",
          capture: captureWithLifecycle(),
          actor,
          autonomy: "auto",
          selectionNow: WAVE3_NOW,
          templateRegistryQuery: async () => [validatedTsTemplate()],
        },
      ),
    ).rejects.toBeInstanceOf(DeployProviderMissingError);
    expect(state.projects.size).toBe(0);
  });

  it("FINDING #1: omitting autonomy keeps safe human defaults but still requires deploy", async () => {
    const { derived, configs } = await runInterviewAndDerive();

    const config = configs.get(derived.projectId);
    expect(config).toBeDefined();
    expect(config?.reviewPolicy).toBe("human");
    expect(config?.mergeIntegration).toBe("not_configured");
    // Even the human tier is greenfield (interview builds off an empty repo) — the
    // safe review/merge defaults hold, but greenfield drives the non-frozen ensure.
    expect(config?.greenfield).toBe(true);
    expect(config?.deployProvider).toBe("deploy.vercel");
  });

  it("FINDING deploy: omitting autonomy does not bypass required deploy", async () => {
    const { pool, state } = stubPool();
    await expect(
      deriveFromCapture(
        { pool },
        {
          orgId: "org_a",
          capture: captureWithLifecycle(),
          actor,
          selectionNow: WAVE3_NOW,
          templateRegistryQuery: async () => [validatedTsTemplate()],
        },
      ),
    ).rejects.toBeInstanceOf(DeployProviderMissingError);
    expect(state.projects.size).toBe(0);
  });

  it("persists the PRODUCT VISION (design-DNA + identity pitch on config; persona surface on metadata) — no migration", async () => {
    const { derived, configs, state } = await runInterviewAndDerive();

    // Design-DNA + identity pitch land on `projects.config.productVision` (the
    // existing jsonb blob — no new table). The interview captured both.
    const config = configs.get(derived.projectId);
    const vision = config?.productVision as { pitch?: string; designDna?: string } | undefined;
    expect(vision).toBeDefined();
    expect(vision?.designDna).toBe("industrial");
    expect(vision?.pitch).toContain("supply chain operations");
    // The persona SURFACE is persisted on the persona `metadata` jsonb (no column).
    const surfaces = state.personaMetadata.map((m) => m["surface"]).filter((s) => s !== undefined);
    expect(surfaces).toContain("desktop");
    expect(surfaces).toContain("handheld");
  });
});
