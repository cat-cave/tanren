// Tests for the LIVE template-creation seams (wave 4) + the selection→creation
// wiring — the real, mountable capability:
//   1. LIVE RESEARCH (`wrapProviderResearcher`): model output → TemplateResearch;
//      grounding flows through; an ungrounded result fails LOUD.
//   2. LIVE BUILD-DRIVER (`buildRunLoopBuildDriver`): the wiring SHAPE (walk → poll
//      convergence → resolve → allocate → clone → bootstrap → handle) + the
//      convergence policy — converge as far as possible; strand ONLY on a GENUINE
//      deadlock. There is NO whole-build wall-clock deadline (polls indefinitely).
//   3. LIVE AUDITOR (`buildTemplateAuditor`): counts `fail`-severity findings.
//   4. SELECTION no-match → CREATION (`selectTemplate` + `createForNoMatch`): no
//      validated template → creation runs → SEED from the freshly-created one.
//
// The model/runner/DB are all SEAMS (a fake adapter, fake sub-seams, an in-memory
// registry) so the wiring is proven without a live model or runner.

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
    // The researched toolchain (current/latest) the model emits so the template-build
    // project gets a non-empty `CaptureLifecycle.toolchain` → a materialized `mise.toml`.
    toolchain: [
      { name: "node", version: "24" },
      { name: "pnpm", version: "11" },
    ],
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
    // The researched toolchain threads onto the lifecycle (apex-v34): this is what
    // makes the template-build project get a `mise.toml` so `mise install` provisions
    // node/pnpm before `just bootstrap` — without it bootstrap fails (`pnpm: not found`).
    expect(research.lifecycle.toolchain).toEqual([
      { name: "node", version: "24" },
      { name: "pnpm", version: "11" },
    ]);
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

// ── LIVE build-driver wiring shape + convergence policy ─────────────────────
// A walker that records walks (the run worker drives actual runs); a snapshot fn
// scripted to converge / strand / linger after N polls.
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
    return { runnerId: "runner_1", imageSha: "img@sha", target: { backend: "ssh" } as RunnerHandle };
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
      convergence: { pollIntervalMs: 1 },
      sleep: async () => {},
    },
  };
}

describe("LIVE build-driver — wiring shape + convergence policy", () => {
  it("walks + polls to convergence, then allocates + clones@sha + bootstraps + resolves a handle", async () => {
    let poll = 0;
    const { ssh, walker, deps } = buildDriverDeps({
      loadSnapshot: async () => {
        poll += 1;
        // first poll: still in flight; second: converged (all done).
        return poll < 2 ? snapshotWith(["in_flight", "pending"]) : snapshotWith(["done", "done"]);
      },
    });
    const built = await buildRunLoopBuildDriver(deps).build({ orgId: "org_acme", projectId: "project_tmpl" });

    // converged after polling (walker kicked each poll); the handle is the converged
    // repo/commit + a resolved config + the auditor; the clone fetched the EXACT sha.
    expect(walker.walked.length).toBeGreaterThanOrEqual(2);
    expect(built.repoRef).toBe(convergedFacts.repoRef);
    expect(built.builtSha).toBe("a".repeat(40));
    expect(built.config).toEqual(DEFAULT_CI_CONFIG);
    expect(built.auditor).toBe(stubAuditor);
    expect(ssh.commands.find((c) => c.command.includes("git fetch"))?.command).toContain("a".repeat(40));

    // the handle's `release` tears down the ALLOCATED validation runner (audit
    // §3.11/4: the validation runner must not leak).
    releasedRunners.length = 0;
    await built.release();
    expect(releasedRunners).toEqual(["runner_1"]);
  });

  it("a GENUINE deadlock (every remaining spec terminal_blocked) fails LOUD — no partial template", async () => {
    // One merged, the only other terminally blocked ⇒ no forward progress ⇒ strand now.
    const { deps } = buildDriverDeps({ loadSnapshot: async () => snapshotWith(["done", "terminal_blocked"]) });
    await expect(buildRunLoopBuildDriver(deps).build({ orgId: "org_acme", projectId: "project_tmpl" })).rejects.toThrow(
      /STRANDED|blocked/u,
    );
  });

  it("one terminal_blocked spec does NOT strand while others can still merge — waits, then converges", async () => {
    // apex live finding: a dependent strands fast, but the scaffold it is blocked behind
    // is still in_flight + mergeable. The build must NOT give up on the first
    // terminal_blocked spec — poll 1: forward progress ⇒ don't strand; poll 2: scaffold
    // merged, dependent re-ready; poll 3: both done ⇒ converged.
    const scripted: Array<DagSnapshot["nodes"][number]["phase"][]> = [
      ["in_flight", "terminal_blocked"],
      ["done", "in_flight"],
      ["done", "done"],
    ];
    let poll = 0;
    const { ssh, walker, deps } = buildDriverDeps({
      loadSnapshot: async () => snapshotWith(scripted[Math.min(poll++, scripted.length - 1)]),
    });
    const built = await buildRunLoopBuildDriver(deps).build({ orgId: "org_acme", projectId: "project_tmpl" });
    // kept polling past the strand and reached convergence.
    expect(walker.walked.length).toBeGreaterThanOrEqual(3);
    expect(built.builtSha).toBe("a".repeat(40));
    expect(ssh.commands.find((c) => c.command.includes("git fetch"))?.command).toContain("a".repeat(40));
  });

  it("a build still progressing NEVER terminates on a wall clock — polls indefinitely until convergence", async () => {
    // The PRINCIPLE: NO whole-build time bound. A blocked strand beside a perpetually-
    // in_flight scaffold keeps forward progress possible (no deadlock), so the driver must
    // KEEP polling — never throw — however much simulated time passes, then converge.
    let clock = 0;
    let poll = 0;
    const pollsBeforeConverge = 5_000;
    const { walker, deps } = buildDriverDeps({
      loadSnapshot: async () => {
        clock += 10 * 60 * 1000;
        poll += 1;
        return poll < pollsBeforeConverge
          ? snapshotWith(["in_flight", "terminal_blocked"])
          : snapshotWith(["done", "done"]);
      },
    });
    const built = await buildRunLoopBuildDriver(deps).build({ orgId: "org_acme", projectId: "project_tmpl" });
    expect(poll).toBe(pollsBeforeConverge);
    expect(clock).toBeGreaterThan(60 * 60 * 1000);
    expect(walker.walked.length).toBe(pollsBeforeConverge);
    expect(built.builtSha).toBe("a".repeat(40));
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

// The flow deps the mount assembles (all sub-infra is a seam; cast stubs since
// assembly does no I/O until the flow runs).
function flowDeps(): CreateTemplateFlowDeps {
  return {
    pool: {} as never,
    secrets: {} as never,
    allocator: fakeAllocator as never,
    ssh: new RecordingSsh() as never,
    identitySecretRef: "id/ref",
    githubHttp: {} as never,
    githubAppMinter: {} as never,
    forgeInfra: { pool: {}, secrets: {}, allocator: fakeAllocator, ssh: {}, identitySecretRef: "id/ref" } as never,
    auditPassRunner: {
      async run() {
        return { findings: [] };
      },
    } as never,
    repoOwner: "cat-cave",
  } as unknown as CreateTemplateFlowDeps;
}

// ── createTemplateFlow assembly (the route is LIVE, not injection-gated) ─────
describe("createTemplateFlow assembly — the live, mountable capability", () => {
  const deps = flowDeps();

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
      // The operator's explicit, linked deploy provider threads through the ctx (type-checks
      // the apex-v33 fix: the no-match build follows the named provider, not a flyio re-guess).
      deployProviderKind: "deploy.vercel",
    });
    expect(typeof seam).toBe("function");
  });
});

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
  const deps = flowDeps();

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
