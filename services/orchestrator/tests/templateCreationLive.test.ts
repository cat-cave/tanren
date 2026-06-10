// Tests for the LIVE template-creation seams (wave 4) + the selection→creation
// wiring — the real, mountable capability:
//   1. the LIVE RESEARCH seam (`wrapProviderResearcher`): a real-model structured
//      call mapped to TemplateResearch; grounding flows through; an ungrounded
//      result fails LOUD at the orchestration boundary.
//   2. the LIVE BUILD-DRIVER seam (`buildRunLoopBuildDriver`): the wiring SHAPE —
//      walk → poll convergence → resolve → allocate → clone → bootstrap → handle;
//      a stranded spec + a convergence timeout both fail LOUD.
//   3. the LIVE AUDITOR (`buildTemplateAuditor`): counts `fail`-severity findings.
//   4. the SELECTION no-match → CREATION wiring (`selectTemplate` + `createForNoMatch`):
//      no validated template → creation runs → SEED from the freshly-created one.
//
// The model/runner/DB are all SEAMS — a fake adapter, fake sub-seams, and an
// in-memory registry — so the wiring is proven without a live model or runner.

import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CI_CONFIG } from "../src/engine/ci/index.js";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../src/engine/contracts/commandSubstrate.js";
import type { DagSnapshot, DagWalker, WalkResult } from "../src/engine/contracts/dagWalker.js";
import type { AnswererAdapter } from "../src/engine/providers/types.js";
import type { AuditPassRunner } from "../src/engine/forge/audits/index.js";
import {
  selectTemplate,
  TemplateRequiredError,
  type SelectedTemplate,
} from "../src/engine/forge/interview/templateSelection.js";
import type { CaptureLifecycle } from "../src/engine/forge/interview/types.js";
import {
  assertGroundedResearch,
  buildRunLoopBuildDriver,
  buildTemplateAuditor,
  type ConvergedProjectFacts,
  wrapProviderResearcher,
} from "../src/engine/templates/index.js";
import { ResearchOutput } from "../src/engine/templates/creation/researchSchema.js";
import {
  buildCreateForNoMatch,
  buildCreateTemplateFlow,
  type CreateTemplateFlowDeps,
} from "../src/routes/templates/createFlow.js";

// ── A fake answerer adapter returning a scripted research output ─────────────
function fakeResearchAdapter(output: ResearchOutput): AnswererAdapter<ResearchOutput> {
  return {
    kind: "answerer",
    cli: "fake",
    authRef: "test/research",
    async runAnswerer() {
      return ResearchOutput.parse(output);
    },
  };
}

const groundedOutput: ResearchOutput = {
  researchSources: ["https://example.test/ts-best-practice", "https://example.test/tooling"],
  lifecycle: {
    bootstrap: "pnpm install",
    tier1: "pnpm typecheck && pnpm lint",
    tier2: "pnpm test",
    tier3: "pnpm test:e2e",
    build: "pnpm build",
    deploy: "pnpm deploy",
  },
  tooling: {
    typecheck: true,
    lint: true,
    test: true,
    mutation: true,
    junit: true,
    bdd: true,
    mutationStep: "pnpm mutation",
  },
  summary: "modern TS/pnpm with tsgo + oxlint + vitest + stryker",
};

const request = { stack: "ts-pnpm", runtime: "node", packageManager: "pnpm", deployTarget: "vercel" };

describe("LIVE research seam — wrapProviderResearcher", () => {
  it("maps the model output to TemplateResearch, carrying provenance + mutationStep", async () => {
    const researcher = wrapProviderResearcher(fakeResearchAdapter(groundedOutput));
    const research = await researcher.research(request);
    expect(research.researchSources).toEqual(groundedOutput.researchSources);
    expect(research.lifecycle.tier1).toBe("pnpm typecheck && pnpm lint");
    expect(research.tooling.mutation).toBe(true);
    expect(research.tooling.mutationStep).toBe("pnpm mutation");
    // grounding gate passes for a sourced result
    expect(() => assertGroundedResearch(research, request.stack)).not.toThrow();
  });

  it("drops mutationStep when the stack bakes no mutation gate (capabilities stay 1:1)", async () => {
    const noMutation: ResearchOutput = {
      ...groundedOutput,
      tooling: { typecheck: true, lint: true, test: true, mutation: false, junit: false, bdd: false },
    };
    const researcher = wrapProviderResearcher(fakeResearchAdapter(noMutation));
    const research = await researcher.research(request);
    expect(research.tooling.mutation).toBe(false);
    expect(research.tooling.mutationStep).toBeUndefined();
  });

  it("an ungrounded research result (no sources) fails LOUD at the grounding boundary", async () => {
    const ungrounded: ResearchOutput = { ...groundedOutput, researchSources: [] };
    const researcher = wrapProviderResearcher(fakeResearchAdapter(ungrounded));
    const research = await researcher.research(request);
    expect(() => assertGroundedResearch(research, request.stack)).toThrow(/ungrounded|no sources/u);
  });
});

// ── LIVE build-driver wiring shape ──────────────────────────────────────────
// A walker that just records walks (the run worker drives the actual runs); a
// snapshot fn scripted to converge after N polls.
function snapshotWith(phases: Array<DagSnapshot["nodes"][number]["phase"]>): DagSnapshot {
  return {
    projectId: "project_tmpl",
    archived: false,
    nodes: phases.map((phase, i) => ({
      specId: `s${String(i)}`,
      phase,
      dependsOn: [],
      priority: "p1",
      orderKey: i,
    })),
  };
}

class RecordingWalker implements DagWalker {
  readonly walked: string[] = [];
  async walk(projectId: string): Promise<WalkResult> {
    this.walked.push(projectId);
    return { projectId, status: "drained", enqueuedSpecIds: [], enqueuedRunIds: [] };
  }
}

// A scripted SSH that records the clone/bootstrap/gate-config commands.
class RecordingSsh implements CommandSubstrate {
  readonly commands: RunnerCommand[] = [];
  async run(_t: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command);
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  }
}

const releasedRunners: string[] = [];
const fakeAllocator = {
  async allocate() {
    return {
      runnerId: "runner_1",
      imageSha: "img@sha",
      target: { backend: "ssh" } as RunnerHandle,
    };
  },
  async release(runnerId: string) {
    releasedRunners.push(runnerId);
  },
};

const convergedFacts: ConvergedProjectFacts = {
  repoRef: "https://example.test/cat-cave/tmpl.git",
  builtSha: "a".repeat(40),
  runnerImage: "tanren/runner:latest",
};

const stubAuditor = {
  async openBlockingFindings() {
    return 0;
  },
};

function buildDriverDeps(overrides: { loadSnapshot: (p: string) => Promise<DagSnapshot> }) {
  const ssh = new RecordingSsh();
  const walker = new RecordingWalker();
  return {
    ssh,
    walker,
    deps: {
      pool: {} as never,
      allocator: fakeAllocator,
      ssh,
      identitySecretRef: "id/ref",
      walker,
      loadSnapshot: overrides.loadSnapshot,
      resolveConverged: async () => convergedFacts,
      auditorFor: () => stubAuditor,
      timeoutMs: 1000,
      convergence: { deadlineMs: 10_000, pollIntervalMs: 1 },
      sleep: async () => {},
      now: () => 0,
    },
  };
}

describe("LIVE build-driver — wiring shape", () => {
  it("walks + polls to convergence, then allocates + clones@sha + bootstraps + resolves a handle", async () => {
    let poll = 0;
    const { ssh, walker, deps } = buildDriverDeps({
      loadSnapshot: async () => {
        poll += 1;
        // first poll: still in flight; second: converged (all done).
        return poll < 2 ? snapshotWith(["in_flight", "pending"]) : snapshotWith(["done", "done"]);
      },
    });
    const driver = buildRunLoopBuildDriver(deps);
    const built = await driver.build({ orgId: "org_acme", projectId: "project_tmpl" });

    // converged after polling; the walker was kicked each poll.
    expect(walker.walked.length).toBeGreaterThanOrEqual(2);
    // the handle is the converged repo/commit + a resolved config + the auditor.
    expect(built.repoRef).toBe(convergedFacts.repoRef);
    expect(built.builtSha).toBe("a".repeat(40));
    expect(built.config).toEqual(DEFAULT_CI_CONFIG);
    expect(built.auditor).toBe(stubAuditor);
    // the clone fetched the EXACT converged sha (not a branch tip).
    const cloned = ssh.commands.find((c) => c.command.includes("git fetch"));
    expect(cloned?.command).toContain("a".repeat(40));

    // the handle carries a `release` that tears down the ALLOCATED validation runner
    // (audit §3.11/4: the validation runner must not leak). Not yet released — the
    // creation flow calls it in its `finally`; calling it here releases runner_1.
    releasedRunners.length = 0;
    await built.release();
    expect(releasedRunners).toEqual(["runner_1"]);
  });

  it("a stranded spec (terminal_blocked) fails LOUD — never validates a partial template", async () => {
    const { deps } = buildDriverDeps({
      loadSnapshot: async () => snapshotWith(["done", "terminal_blocked"]),
    });
    const driver = buildRunLoopBuildDriver(deps);
    await expect(driver.build({ orgId: "org_acme", projectId: "project_tmpl" })).rejects.toThrow(/STRANDED|blocked/u);
  });

  it("a non-converging build fails LOUD at the deadline", async () => {
    let clock = 0;
    const { ssh, deps } = buildDriverDeps({
      loadSnapshot: async () => snapshotWith(["in_flight", "pending"]),
    });
    const driver = buildRunLoopBuildDriver({
      ...deps,
      now: () => (clock += 5_000),
      convergence: { deadlineMs: 9_000, pollIntervalMs: 1 },
    });
    await expect(driver.build({ orgId: "org_acme", projectId: "project_tmpl" })).rejects.toThrow(/did not converge/u);
    // never reached the clone (no convergence).
    expect(ssh.commands.find((c) => c.command.includes("git fetch"))).toBeUndefined();
  });
});

// ── LIVE auditor — counts blocking findings ─────────────────────────────────
describe("LIVE auditor — buildTemplateAuditor", () => {
  it("counts ONLY block-worthy P0/P1 findings as blocking (P2/P3 are not)", async () => {
    const passRunner: AuditPassRunner = {
      async run() {
        return {
          findings: [
            { externalId: "a", title: "x", body: "y", severity: "P3" },
            { externalId: "b", title: "x", body: "y", severity: "P2" },
            { externalId: "c", title: "x", body: "y", severity: "P0" },
          ],
        };
      },
    };
    const auditor = buildTemplateAuditor({ passRunner, orgId: "org_acme", projectId: "project_tmpl" });
    expect(await auditor.openBlockingFindings({ workspacePath: "/ws", baselineSha: "a".repeat(40) })).toBe(1);
  });

  it("a clean pass (no P0/P1 findings) → 0 blocking → auditorClean", async () => {
    const passRunner: AuditPassRunner = {
      async run() {
        return { findings: [{ externalId: "a", title: "x", body: "y", severity: "P2" }] };
      },
    };
    const auditor = buildTemplateAuditor({ passRunner, orgId: "org_acme", projectId: "project_tmpl" });
    expect(await auditor.openBlockingFindings({ workspacePath: "/ws", baselineSha: "a".repeat(40) })).toBe(0);
  });
});

// ── createTemplateFlow assembly (the route is LIVE, not injection-gated) ─────
describe("createTemplateFlow assembly — the live, mountable capability", () => {
  // The flow deps the mount assembles (all sub-infra is a seam; cast stubs since
  // assembly does no I/O until the flow runs).
  const deps = {
    pool: {} as never,
    secrets: {} as never,
    allocator: fakeAllocator as never,
    ssh: new RecordingSsh() as never,
    identitySecretRef: "id/ref",
    vcsProvider: {} as never,
    githubAppMinter: {} as never,
    forgeInfra: { pool: {}, secrets: {}, allocator: fakeAllocator, ssh: {}, identitySecretRef: "id/ref" } as never,
    auditPassRunner: {
      async run() {
        return { findings: [] };
      },
    } as never,
    repoOwner: "cat-cave",
  } as unknown as CreateTemplateFlowDeps;

  it("buildCreateTemplateFlow assembles a runnable flow (the route mounts it unconditionally)", () => {
    const flow = buildCreateTemplateFlow(deps);
    expect(typeof flow).toBe("function");
  });

  it("buildCreateForNoMatch assembles the decoupled selection→creation seam (lifecycle → SelectedTemplate)", () => {
    const seam = buildCreateForNoMatch(deps, {
      orgId: "org_acme",
      actor: { userId: "u", orgId: "org_acme", projectId: null, scopes: ["org:admin"], source: "session" },
      templateRegistryQuery: async () => [],
      repoOwner: "cat-cave",
    });
    expect(typeof seam).toBe("function");
  });
});

// The no-match seam is ASYNC (audit §3.11/3): it must NOT run the 60-min creation
// inline in the derive request. It (1) checks the registry for an existing validated
// match synchronously (seed it if present), else (2) fires creation in the BACKGROUND
// and returns `undefined` immediately so the derive proceeds from-scratch THIS run.
// A pool whose template-capability query returns the scripted rows; records calls.
function poolReturning(rows: ReadonlyArray<unknown>) {
  const queries: string[] = [];
  return {
    queries,
    pool: {
      async query(sql: string) {
        queries.push(sql.replaceAll(/\s+/gu, " ").trim());
        return { rows };
      },
    } as never,
  };
}

describe("buildCreateForNoMatch — synchronous create-then-seed, owner-threaded", () => {
  // Local flow deps (the assembly does no I/O until the flow runs; all sub-infra stubbed).
  const deps = {
    pool: {} as never,
    secrets: {} as never,
    allocator: fakeAllocator as never,
    ssh: new RecordingSsh() as never,
    identitySecretRef: "id/ref",
    vcsProvider: {} as never,
    githubAppMinter: {} as never,
    forgeInfra: { pool: {}, secrets: {}, allocator: fakeAllocator, ssh: {}, identitySecretRef: "id/ref" } as never,
    auditPassRunner: {
      async run() {
        return { findings: [] };
      },
    } as never,
    repoOwner: "cat-cave",
  } as unknown as CreateTemplateFlowDeps;

  const ctx = {
    orgId: "org_acme",
    actor: { userId: "u", orgId: "org_acme", projectId: null, scopes: ["org:admin"], source: "session" as const },
    templateRegistryQuery: async () => [],
    repoOwner: "cat-cave",
  };

  it("an EXISTING validated match seeds THIS derive synchronously (no creation)", async () => {
    const { pool } = poolReturning([
      {
        id: "template_existing",
        org_id: "org_acme",
        repo_ref: "cat-cave/tanren-template-ts-next",
        status: "validated",
        channel: "lts",
        manifest: {
          version: 1,
          stack: "ts-pnpm",
          channel: "lts",
          templateVersion: "1.0.0",
          provenance: { researchSources: ["https://nextjs.org"] },
          capabilities: {
            runtime: "node",
            packageManager: "pnpm",
            gates: ["tier-1"],
            bdd: true,
            mutation: false,
            junit: true,
          },
          validationProof: {
            positiveControlsPassed: true,
            negativeControls: { typecheck: "proven", lint: "proven", test: "proven", mutation: "n/a" },
            auditorClean: true,
            validatedAt: "2026-06-01T00:00:00.000Z",
            validatedSha: "abc1234",
          },
        },
      },
    ]);
    const seam = buildCreateForNoMatch({ ...deps, pool }, ctx);
    const selected = await seam(lifecycle);
    expect(selected?.templateRef).toBe("template_existing");
    expect(selected?.repoRef).toBe("cat-cave/tanren-template-ts-next");
  });

  it("NO existing match → runs creation SYNCHRONOUSLY (gates the scaffold; never fire-and-forget)", async () => {
    const { pool } = poolReturning([]);
    // The doctrine cutover: on no match the seam runs the creation meta-flow inline and
    // SEEDS from the published template — the project scaffold GATES on it (it does NOT
    // return undefined-then-proceed-from-scratch). With these loosely-mocked deps the
    // creation drives into the (un-mockable) research/build infra and THROWS — proving
    // the seam awaits creation synchronously and PROPAGATES the failure (so selection
    // halts loud), rather than detaching and resolving undefined.
    const seam = buildCreateForNoMatch({ ...deps, pool }, ctx);
    // The loosely-mocked research/build infra throws as soon as creation drives into it
    // (here: the stub pool has no real `query`) — proving the seam awaited creation
    // synchronously and propagated, rather than detaching + resolving undefined.
    await expect(seam(lifecycle)).rejects.toThrow(/is not a function|query|research/u);
  });
});

// ── SELECTION no-match → CREATION wiring ────────────────────────────────────
const lifecycle: CaptureLifecycle = {
  stack: "ts/pnpm",
  bootstrap: "pnpm install",
  tier1: "pnpm typecheck",
  tier2: "pnpm test",
  tier3: "pnpm e2e",
  build: "pnpm build",
  deploy: "vercel deploy",
};

describe("SELECTION no-match → CREATION (createForNoMatch seam)", () => {
  it("no eligible template + a wired createForNoMatch → CREATES + SEEDS (strong match)", async () => {
    const created: SelectedTemplate = {
      templateRef: "template_new",
      repoRef: "cat-cave/tmpl-ts",
      validationProof: {
        positiveControlsPassed: true,
        negativeControls: { typecheck: "proven", lint: "proven", test: "proven", mutation: "n/a" },
        auditorClean: true,
        validatedAt: "2026-06-09T12:00:00.000Z",
        validatedSha: "a".repeat(40),
      },
    };
    let calledWith: CaptureLifecycle | undefined;
    const decision = await selectTemplate({
      lifecycle,
      actor: { kind: "operator" },
      // empty registry → no eligible match
      registryQuery: async () => [],
      createForNoMatch: async (lc) => {
        calledWith = lc;
        return created;
      },
    });
    expect(decision.kind).toBe("strong");
    expect(decision.selected).toEqual(created);
    expect(decision.reasons).toContain("created");
    expect(calledWith).toEqual(lifecycle);
  });

  it("without the seam → HALTS LOUD (no project-direct from-scratch)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      selectTemplate({
        lifecycle,
        actor: { kind: "operator" },
        registryQuery: async () => [],
      }),
    ).rejects.toThrow(TemplateRequiredError);
    warn.mockRestore();
  });

  it("a FAILED creation HALTS LOUD (fail-closed) — never a silent from-scratch", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      selectTemplate({
        lifecycle,
        actor: { kind: "operator" },
        registryQuery: async () => [],
        createForNoMatch: async () => {
          throw new Error("validation failed");
        },
      }),
    ).rejects.toThrow(TemplateRequiredError);
    warn.mockRestore();
  });
});
