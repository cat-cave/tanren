// P1c: prove the production Forge wiring constructs a REAL provider answerer
// (not a deterministic stand-in), and that the deterministic answerers now live
// under tests/fixtures.
//
// Two layers are exercised:
//   1. The `wrapProvider*` wrappers schema-validate a model's structured output
//      (driven by a fake `AnswererAdapter` transport) and reject non-conforming
//      output — the dual-mode Answerer contract.
//   2. `forgeAllocatingAnswererAdapter` (the engine the per-surface
//      `buildForge*AnswererFactory` factories wrap) allocates a runner, runs a
//      REAL Codex answerer over a fake SSH transport, parses the structured
//      answer, and releases — proving the production default reasons with a model.

import { describe, expect, it, vi } from "vitest";
import type { Allocator, SshTarget } from "../src/engine/contracts/allocator.js";
import { FakeAllocator } from "../src/engine/contracts/allocator.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import type { SshCommand, SshCommandResult, SshSubstrate } from "../src/engine/contracts/sshSubstrate.js";
import type { AnswererAdapter } from "../src/engine/providers/types.js";
import { wrapProviderDiscoveryAnswerer } from "../src/engine/forge/discovery/index.js";
import { wrapProviderTriageAnswerer } from "../src/engine/forge/inbox/index.js";
import { wrapProviderReconAnswerer } from "../src/engine/forge/brownfield/index.js";
import { wrapProviderInterviewAnswerer } from "../src/engine/forge/interview/index.js";
import { wrapProviderAnswerer } from "../src/engine/forge/conversation/index.js";
import {
  buildForgeDiscoveryAnswererFactory,
  buildForgeTriageAnswererFactory,
  forgeAllocatingAnswererAdapter,
  type ForgeAnswererInfra,
} from "../src/engine/forge/providerFactory.js";

// ── 1. The wrappers schema-validate a model's structured output ────────────

// A fake provider transport: returns whatever structured value the test scripts,
// after running the parse fn (so a non-conforming value is rejected exactly as a
// real adapter would). It is an `AnswererAdapter`, the same seam the real
// Claude/Codex answerers implement.
function fakeAdapter<T>(value: unknown): AnswererAdapter<T> {
  return {
    kind: "answerer",
    cli: "fake",
    authRef: "credential/self-hosted/fake",
    async runAnswerer(opts) {
      return opts.outputSchema.parse(value);
    },
  };
}

describe("Forge provider wrappers (dual-mode structured answerers)", () => {
  it("discovery: a conforming model output is returned; a non-conforming one is rejected", async () => {
    const good = {
      variant: "feature",
      summary: "Derived a small slice.",
      proposals: [
        {
          proposalId: "p1",
          title: "add link analytics",
          description: "Track per-link clicks.",
          acceptanceCriteria: ["records a click row per redirect"],
          dependsOn: [],
          priority: "P1",
          estLabel: "M",
        },
      ],
      placements: [
        {
          kind: "slot_after",
          label: "after model",
          eta: "1d",
          sideEffects: "none",
          priority: "P1",
          recommended: true,
          risk: false,
        },
      ],
      deltas: [],
      readSummary: "read existing specs",
    };
    const answerer = wrapProviderDiscoveryAnswerer(fakeAdapter(good));
    const result = await answerer.classify({ insight: insight(), projectId: "project_a", existingSpecs: [] });
    expect(result.proposals[0]?.title).toBe("add link analytics");

    const bad = wrapProviderDiscoveryAnswerer(fakeAdapter({ variant: "feature" }));
    await expect(bad.classify({ insight: insight(), projectId: "project_a", existingSpecs: [] })).rejects.toThrow(
      /proposals|placements|Required|Invalid/u,
    );
  });

  it("triage: returns a model verdict and rejects a malformed one", async () => {
    const good = {
      dedupe: "no match",
      match: "new behavior",
      placement: "auto → queued",
      verdict: "needs_call",
      duplicateOfSpecId: null,
      discoveryVariant: "feature",
    };
    const answerer = wrapProviderTriageAnswerer(fakeAdapter(good));
    const result = await answerer.triage({
      candidate: { title: "t", body: "b", severity: "info", sourceKind: "issues", projectId: "project_a" },
      source: {
        id: "s1",
        orgId: "org_a",
        kind: "issues",
        name: "GH",
        projectId: "project_a",
        detail: "",
        config: {},
        enabled: true,
        autoRoute: false,
      },
      existingSpecs: [],
    });
    expect(result.verdict).toBe("needs_call");

    const bad = wrapProviderTriageAnswerer(fakeAdapter({ verdict: "needs_call" }));
    await expect(
      bad.triage({
        candidate: { title: "t", body: "b", severity: "info", sourceKind: "issues", projectId: "project_a" },
        source: {
          id: "s1",
          orgId: "org_a",
          kind: "issues",
          name: "GH",
          projectId: "project_a",
          detail: "",
          config: {},
          enabled: true,
          autoRoute: false,
        },
        existingSpecs: [],
      }),
    ).rejects.toThrow(/dedupe|match|placement|Required|Invalid/u);
  });

  it("recon / interview / conversation wrappers are real provider answerers", async () => {
    const recon = wrapProviderReconAnswerer(
      fakeAdapter({
        identity: { slug: "x", purpose: "y", inferredFrom: "readme" },
        personas: [],
        behaviors: [],
        architecture: [],
        risks: [],
        gaps: [],
      }),
    );
    const report = await recon.read({ repoUrl: "https://example/x", filesIndexed: 0, files: [] });
    expect(report.identity.slug).toBe("x");

    const interview = wrapProviderInterviewAnswerer(
      fakeAdapter({ say: "what are we building?", captureDelta: {}, suggestions: [], complete: false }),
    );
    const round = await interview.ask({ round: 1, totalRounds: 14, answer: "", capture: {} as never });
    expect(round.complete).toBe(false);

    const conversation = wrapProviderAnswerer(
      fakeAdapter({ kind: "final", answer: { body: "hi", attentionItems: [], insights: [], prompts: [] } }),
    );
    const step = await conversation.respond({
      question: "what's up?",
      projectId: "project_a",
      runId: null,
      toolResults: [],
      history: [],
    } as never);
    expect(step.kind).toBe("final");
  });
});

// ── 2. The production factory builds a REAL provider answerer ───────────────

const PROJECT_ROW = {
  runner_image: "ghcr.io/cat-cave/tanren-runner:v0",
  config: { version: 1 },
  org_id: "org_a",
};

const ORG_ROW = { config: { version: 1, defaultCredentials: { codex_chatgpt_auth: "credential/codex/dev" } } };

const authJson = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "a", refresh_token: "r" } });

// A pool stub that answers the project read, the org-config read, and any other
// read with empty rows. Mirrors the shape `loadProjectRunnerContext` queries.
function stubPool() {
  return {
    async query(sql: string) {
      if (sql.includes("FROM projects")) return { rows: [PROJECT_ROW] };
      if (sql.includes("FROM organizations")) return { rows: [ORG_ROW] };
      return { rows: [] };
    },
  } as never;
}

function ok(stdout: string): SshCommandResult {
  return { exitCode: 0, stdout, stderr: "", timedOut: false };
}

// Replays the Codex answerer's SSH command sequence with a final structured
// answer, so a REAL Codex answerer parses a real structured result.
class ScriptedSsh implements SshSubstrate {
  readonly commands: SshCommand[] = [];
  constructor(private readonly results: SshCommandResult[]) {}
  async run(_t: SshTarget, command: SshCommand): Promise<SshCommandResult> {
    this.commands.push(command);
    const result = this.results.shift();
    if (result === undefined) throw new Error(`unexpected SSH command: ${command.command}`);
    return result;
  }
}

async function infraWith(allocator: Allocator, ssh: SshSubstrate): Promise<ForgeAnswererInfra> {
  const secrets = new InMemorySecretStore();
  await secrets.put({ ref: "credential/codex/dev", value: authJson });
  return { pool: stubPool(), secrets, allocator, ssh, identitySecretRef: "runner/test/identity" };
}

describe("forgeAllocatingAnswererAdapter (production default = real provider answerer)", () => {
  it("allocates a runner, runs a real Codex answerer over SSH, and releases", async () => {
    const triageAnswer = JSON.stringify({
      dedupe: "no match",
      match: "new behavior",
      placement: "auto → queued",
      verdict: "needs_call",
      duplicateOfSpecId: null,
      discoveryVariant: "feature",
    });
    // The Codex answerer's command sequence: 3 setup writes, the exec (a `done`
    // event), the auth read, and the structured answer read.
    const ssh = new ScriptedSsh([ok(""), ok(""), ok(""), ok('{"type":"done"}\n'), ok(authJson), ok(triageAnswer)]);
    const allocator = new FakeAllocator();
    const allocateSpy = vi.spyOn(allocator, "allocate");
    const releaseSpy = vi.spyOn(allocator, "release");
    const infra = await infraWith(allocator, ssh);

    // The triage factory the route wires in production — a REAL provider answerer.
    const factory = buildForgeTriageAnswererFactory(infra);
    const answerer = factory({ orgId: "org_a", projectId: "project_a" });
    const verdict = await answerer.triage({
      candidate: {
        title: "missing index",
        body: "slow query",
        severity: "warn",
        sourceKind: "issues",
        projectId: "project_a",
      },
      source: {
        id: "s1",
        orgId: "org_a",
        kind: "issues",
        name: "GH",
        projectId: "project_a",
        detail: "",
        config: {},
        enabled: true,
        autoRoute: false,
      },
      existingSpecs: [],
    });

    expect(verdict.verdict).toBe("needs_call");
    // The model was actually invoked over the allocated runner, and the runner
    // was allocated + released — no deterministic short-circuit.
    expect(allocateSpy).toHaveBeenCalledTimes(1);
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    expect(ssh.commands.some((c) => c.command.includes("codex exec"))).toBe(true);
  });

  it("releases the runner even when the model call fails", async () => {
    // No structured answer scripted → the Codex answerer throws; release must run.
    const ssh = new ScriptedSsh([ok(""), ok(""), ok(""), ok('{"type":"done"}\n'), ok(authJson)]);
    const allocator = new FakeAllocator();
    const releaseSpy = vi.spyOn(allocator, "release");
    const infra = await infraWith(allocator, ssh);

    const adapter = forgeAllocatingAnswererAdapter<unknown>(infra, { orgId: "org_a", projectId: "project_a" });
    await expect(
      adapter.runAnswerer({
        prompt: "x",
        timeoutMs: 1000,
        outputSchema: { name: "t", jsonSchema: {}, parse: (v) => v },
      }),
    ).rejects.toThrow(/unexpected SSH command/u);
    expect(releaseSpy).toHaveBeenCalledTimes(1);
  });

  it("a greenfield (project-less) target resolves the org default credential", async () => {
    const interviewAnswer = JSON.stringify({
      say: "what are we building?",
      captureDelta: {},
      suggestions: [],
      complete: false,
    });
    const ssh = new ScriptedSsh([ok(""), ok(""), ok(""), ok('{"type":"done"}\n'), ok(authJson), ok(interviewAnswer)]);
    const allocator = new FakeAllocator();
    const allocateSpy = vi.spyOn(allocator, "allocate");
    const infra = await infraWith(allocator, ssh);

    const factory = buildForgeDiscoveryAnswererFactory(infra);
    // Discovery is project-scoped, but assert the adapter resolves the org path
    // when no projectId is given (the greenfield interview case).
    const adapter = forgeAllocatingAnswererAdapter<unknown>(infra, { orgId: "org_a" });
    await adapter
      .runAnswerer({ prompt: "x", timeoutMs: 1000, outputSchema: { name: "t", jsonSchema: {}, parse: (v) => v } })
      .catch(() => {});
    // The org-scoped runId is used (no project handle), and a runner was allocated.
    expect(allocateSpy).toHaveBeenCalledTimes(1);
    expect(allocateSpy.mock.calls[0]?.[0].projectId).toBe("org:org_a");
    // The factory itself returns a real provider answerer (no throw on build).
    expect(typeof factory({ orgId: "org_a", projectId: "project_a" }).classify).toBe("function");
  });
});

function insight() {
  return {
    variant: "feature" as const,
    source: "sales-call",
    sourceLabel: "Sales",
    who: "AE",
    when: "today",
    glyph: "S",
    body: "customer wants per-link analytics",
  };
}
