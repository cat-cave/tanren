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
import type { MaterializeTemplate, SeededTemplate } from "../src/engine/templates/index.js";
import { createDeterministicInterviewAnswerer } from "./fixtures/forge/deterministicInterviewAnswerer.js";
import {
  preparedDeploy,
  stubPool,
  successfulBootstrapProject,
  type StubState,
} from "./fixtures/forge/interviewDeriveStub.js";

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

// A minimal, EXPLICIT design contract (native design subsystem, WS-D1) — required at
// derive (the no-silent-noop guard, mirroring the lifecycle guard). Minimal by design:
// an explicit, design-light contract is valid; a silent absence is not.
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

// A capture WITH the lifecycle + an explicit design contract (so a deploy-guard test
// isolates the deploy guard, not the earlier missing-lifecycle / missing-design-contract
// guards).
const captureWithLifecycle = (): InterviewCapture => ({
  ...emptyCapture(),
  lifecycle: TS_LIFECYCLE,
  designContract: MINIMAL_DESIGN_CONTRACT,
});

// PR-G (task #77) — the materializer pushes the composed VFS DIRECTLY into the
// project repo (no intermediate `tanren-tmpl-*` seed repo). The stub returns a
// deterministic opaque `SeededTemplate` (templateRef + validatedAt) the derive
// persists onto the project config for observability.
const SEED_NOW = "2026-06-09T00:00:00.000Z";
function fixtureSeed(slug: string): SeededTemplate {
  return {
    templateRef: `tanren://composed/${slug}@deadbeefcafe1234`,
    validatedAt: SEED_NOW,
  };
}
function stubMaterialize(): MaterializeTemplate {
  return async (input) => fixtureSeed(input.config.slug);
}

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
// DOCTRINE (docs/roadmap/templating-system.md): every project DAG seeds from a
// fragment-composed template; the shared helper wires the stub materializer so
// derive lands a deterministic seed onto the project config.
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
    materializeTemplate: stubMaterialize(),
    bootstrapProject: successfulBootstrapProject,
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
      // The fragment-composed seed materializer needs an `owner` to create the
      // template seed repo; the test stub `stubMaterialize` returns a fixture
      // seed without touching GitHub.
      owner: "cat-cave",
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

  it("derives scaffold/build/deploy FROM the captured lifecycle + PERSISTS the lifecycle + opaque templateRef (PR-G)", async () => {
    // The deterministic answerer captures a TS/pnpm lifecycle; the lifecycle is
    // PERSISTED on the project config so the RUN materializes the contract files
    // deterministically (no LLM authoring), and the scaffold spec's WRITER
    // specializes the composed seed for THIS product. build/deploy route through
    // the conventional targets FROM the captured lifecycle.
    const { derived, state, configs } = await runInterviewAndDerive();
    const [scaffold, build, deploy] = derived.specIds.map((id) => state.specs.get(id));

    const config = configs.get(derived.projectId) as
      | { lifecycle?: { stack?: string; bootstrap?: string }; templateRef?: string }
      | undefined;
    expect(config?.lifecycle?.stack).toBe("ts/pnpm");
    expect(config?.lifecycle?.bootstrap).toBe("pnpm install");
    // PR-G — the OPAQUE composed-template identifier is persisted on the project
    // config for observability. No GitHub repo exists at this ref; the composed
    // VFS is already in the project repo as its initial content.
    expect(config?.templateRef).toMatch(/^tanren:\/\/composed\//u);

    const desc = scaffold?.description ?? "";
    expect(desc.toLowerCase()).toMatch(/seed from|already committed|pre-committed|materialized|composed seed/u);
    expect(desc).toContain("justfile");
    expect(desc).toContain(".tanren/ci.yml");
    // The green bar is bootstrap/tier-1/build — NOT the test tier.
    const criteria = scaffold?.acceptanceCriteria ?? [];
    expect(criteria.find((c) => /each exits 0|are green/u.test(c))).toContain("just bootstrap");
    expect(criteria.some((c) => /(just tier-2|just tier-3).*exits 0/u.test(c))).toBe(false);

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
        owner: "cat-cave",
        autonomy: "auto",
        deploy: { providerKind: "deploy.vercel" },
        materializeTemplate: stubMaterialize(),
        bootstrapProject: successfulBootstrapProject,
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
    // TASK #79: derive(autonomy:"auto") lands the AUTONOMOUS audit posture +
    // CI-intelligence threshold ATOMICALLY with project creation — the
    // DagWalker auto-claims within seconds and cannot observe a partially
    // configured project. The §2.5 governance PUT is no longer required for
    // autonomous runs; without these the audit-posture preflight would halt the
    // first scaffold run on `audit.posture_strands_findings`.
    expect(config?.auditPosture).toEqual({
      blockReviewAt: "P1",
      p2p3Handling: "route-to-dag",
      autonomousRemediation: true,
    });
    expect(config?.insightThresholds).toEqual({ ciInsightFlakyMinShas: 1 });
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
    // The deploy guard is hoisted BEFORE template resolution so a missing deploy
    // fails fast (without spending compose+materialize work on a project that
    // cannot deploy anyway).
    await expect(
      deriveFromCapture(
        { pool },
        {
          orgId: "org_a",
          capture: captureWithLifecycle(),
          actor,
          autonomy: "auto",
          materializeTemplate: stubMaterialize(),
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
    // The doctrine collapse removed the templateBuild config marker entirely:
    // there is no template_build mode any more, so the field is absent.
    expect((config as { templateBuild?: unknown })?.templateBuild).toBeUndefined();
    // TASK #79: the inverse of the autonomy:"auto" atomicity — a non-autonomous
    // project lands with the BALANCED audit posture default (P0/P1 block + park
    // for a human, residual fix-if-idle) and EMPTY insight-threshold overrides.
    // The conservative posture remains; an operator may flip the project to
    // autonomous later via the §2.5 governance PUT (the operator-controllable
    // surface remains intact). This is the inverse of the autonomous derive that
    // pre-applies AUTONOMOUS_AUDIT_POSTURE + ciInsightFlakyMinShas:1 atomically.
    expect(config?.auditPosture).toEqual({
      blockReviewAt: "P1",
      p2p3Handling: "fix-if-idle",
      autonomousRemediation: false,
    });
    expect(config?.insightThresholds).toEqual({});
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
          materializeTemplate: stubMaterialize(),
        },
      ),
    ).rejects.toBeInstanceOf(DeployProviderMissingError);
    expect(state.projects.size).toBe(0);
  });

  it("persists the PRODUCT VISION (design note + identity pitch on config; persona surface on metadata) — no migration", async () => {
    const { derived, configs, state } = await runInterviewAndDerive();

    // The design note (the captured design contract's one-line `identity`) +
    // identity pitch land on `projects.config.productVision` (the existing jsonb
    // blob — no new table) for the conflict resolver. The interview captured both.
    const config = configs.get(derived.projectId);
    const vision = config?.productVision as { pitch?: string; designDna?: string } | undefined;
    expect(vision).toBeDefined();
    expect(vision?.designDna).toBe("an industrial, dense, trustworthy ops console");
    expect(vision?.pitch).toContain("supply chain operations");
    // The persona SURFACE is persisted on the persona `metadata` jsonb (no column).
    const surfaces = state.personaMetadata.map((m) => m["surface"]).filter((s) => s !== undefined);
    expect(surfaces).toContain("desktop");
    expect(surfaces).toContain("handheld");
  });

  it("persists the captured DESIGN CONTRACT as a first-class versioned entity (native design subsystem, WS-D1)", async () => {
    const { derived, state } = await runInterviewAndDerive();

    // The interview captured a design contract → derive persists it as a
    // first-class `design_contracts` row (version 1), and surfaces its id. The
    // contract is DOMAIN-GENERAL: a typed core + domain-adaptive dimensions.
    expect(derived.designContractId).toBeDefined();
    expect(state.designContracts).toHaveLength(1);
    const contract = state.designContracts[0] as {
      version?: number;
      domain?: string;
      identity?: string;
      intent?: string;
      personaRefs?: string[];
      behaviorRefs?: string[];
      dimensions?: Array<{ key: string; personaRefs: string[] }>;
    };
    expect(contract.version).toBe(1);
    expect(contract.domain).toBe("saas-web");
    expect(contract.identity).toBe("an industrial, dense, trustworthy ops console");
    expect(Array.isArray(contract.dimensions)).toBe(true);

    // THE MOAT — the captured persona NAMES + behavior keys resolved to the
    // PERSISTED persona/behavior ids (first-class links, not freeform text). The
    // deterministic interview bound two personas + two behaviors, plus a
    // persona-scoped layout dimension (the line worker's view).
    expect(contract.personaRefs).toBeDefined();
    expect(contract.personaRefs).toHaveLength(2);
    expect(contract.behaviorRefs).toBeDefined();
    expect(contract.behaviorRefs).toHaveLength(2);
    // Every resolved ref is a real persisted id (no dangling refs).
    for (const ref of contract.personaRefs ?? []) expect(ref).toMatch(/^persona_/u);
    const layout = (contract.dimensions ?? []).find((d) => d.key === "layout");
    expect(layout?.personaRefs).toHaveLength(1);
    expect(layout?.personaRefs[0]).toMatch(/^persona_/u);
  });
});
