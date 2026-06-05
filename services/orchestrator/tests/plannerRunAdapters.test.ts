// Behavior tests for defaultRoutingAdapters — the production builder that
// resolves the run's four role adapters (plan/write/check/audit) from the
// project's effective routing table via the shared adapter selector. These pin
// the core claim of the routing-driven path: the writer/answerer providers come
// from DATA (the routing chain heads), and a missing/empty role chain is a HARD
// failure — never a silent Codex fallback.

import { describe, expect, it } from "vitest";
import { emptyRoutingTable, RoutingTable } from "../src/engine/config/shared.js";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import { EmptyRoutingChainError } from "../src/engine/providers/adapterSelector.js";
import { defaultRoutingAdapters } from "../src/engine/workflow/plannerRunAdapters.js";
import type { PlannerRunAdapterContext, RunPlannerLoopInput } from "../src/engine/workflow/plannerRun.js";

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};

class NoopSsh implements CommandSubstrate {
  async run(_target: RunnerHandle, _command: RunnerCommand): Promise<CommandResult> {
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  }
}

// The minimal RunPlannerLoopInput defaultRoutingAdapters reads: secrets, ssh,
// and the run context's routing + optional endpoint override. The rest of the
// loop input is irrelevant to adapter construction.
function input(routing: RunPlannerLoopInput["context"]["routing"]): RunPlannerLoopInput {
  return {
    secrets: new InMemorySecretStore(),
    ssh: new NoopSsh(),
    context: {
      runId: "run_1",
      specId: "spec_1",
      projectId: "project_1",
      repoUrl: "https://example.invalid/repo",
      targetBranch: "main",
      runBranch: "tanren/x",
      specTitle: "t",
      specDescription: "d",
      acceptanceCriteria: [],
      runnerImage: "img",
      identitySecretRef: "id",
      githubCredentialRef: "cred/gh",
      routing,
    },
  } as unknown as RunPlannerLoopInput;
}

const ctx: PlannerRunAdapterContext = { runId: "run_1", target, codexHome: "/home/tanren/.codex/run_1" };

describe("defaultRoutingAdapters", () => {
  it("selects each role's adapter from the project routing table (not a Codex hardcode)", () => {
    const routing = RoutingTable.parse({
      plan: { chain: [{ cli: "claude", model: "claude-opus-4-8", authRef: "cred/claude" }] },
      write: { chain: [{ cli: "opencode", model: "zai/glm-5.1", authRef: "cred/opencode" }] },
      check: { chain: [{ cli: "codex", model: "default", authRef: "cred/codex" }] },
      audit: { chain: [{ cli: "claude", model: "claude-opus-4-8", authRef: "cred/claude" }] },
    });
    const adapters = defaultRoutingAdapters(input(routing), ctx);
    expect(adapters.planner.cli).toBe("claude");
    expect(adapters.writer.cli).toBe("opencode");
    expect(adapters.checker.cli).toBe("codex");
    expect(adapters.auditor.cli).toBe("claude");
  });

  it("yields Codex adapters when the routing data heads every role with Codex (the default)", () => {
    const routing = RoutingTable.parse({
      plan: { chain: [{ cli: "codex", model: "default", authRef: "cred/codex" }] },
      write: { chain: [{ cli: "codex", model: "default", authRef: "cred/codex" }] },
      check: { chain: [{ cli: "codex", model: "default", authRef: "cred/codex" }] },
      audit: { chain: [{ cli: "codex", model: "default", authRef: "cred/codex" }] },
    });
    const adapters = defaultRoutingAdapters(input(routing), ctx);
    expect(adapters.writer.cli).toBe("codex");
    expect(adapters.planner.cli).toBe("codex");
  });

  it("hard-fails (no Codex fallback) when a required role's chain is empty", () => {
    // An empty routing table leaves every loop role unresolvable; the selector
    // throws EmptyRoutingChainError rather than silently defaulting to Codex.
    expect(() => defaultRoutingAdapters(input(emptyRoutingTable()), ctx)).toThrow(EmptyRoutingChainError);
  });

  it("hard-fails when the run context carries no routing at all", () => {
    const noRouting: RunPlannerLoopInput["context"]["routing"] = undefined;
    expect(() => defaultRoutingAdapters(input(noRouting), ctx)).toThrow(/routing is required/u);
  });
});
