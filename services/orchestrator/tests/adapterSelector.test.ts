import { describe, expect, it } from "vitest";
import { RoutingChainEntry, RoutingTable } from "../src/engine/config/shared.js";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import {
  buildAdaptersFromRouting,
  buildAnswererAdapter,
  buildWriterAdapter,
  EmptyRoutingChainError,
  SELECTABLE_ANSWERER_CLIS,
  SELECTABLE_WRITER_CLIS,
  UnsupportedProviderError,
} from "../src/engine/providers/adapterSelector.js";
import type { CheckAnswer } from "../src/engine/providers/answererSchemas.js";
import {
  HARNESS_CAPABILITIES,
  HARNESS_PROTOCOL_VERSION,
  harnessSupportsRole,
} from "../src/engine/providers/harnessCapability.js";

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};

function deps() {
  return { secrets: new InMemorySecretStore(), ssh: new NoopSsh(), target, runId: "run_sel_1" };
}

function entry(cli: string, model: string, authRef: string): RoutingChainEntry {
  return RoutingChainEntry.parse({ cli, model, authRef });
}

describe("adapter selector (P3-0012 fallback-chain resolution)", () => {
  it("resolves codex, claude, opencode, and aider writer chain entries to the right cli", () => {
    expect(buildWriterAdapter(deps(), entry("codex", "gpt-5", "credential/codex/dev")).cli).toBe("codex");
    expect(buildWriterAdapter(deps(), entry("claude", "claude-opus-4-8", "credential/claude/dev")).cli).toBe("claude");
    expect(buildWriterAdapter(deps(), entry("opencode", "zai/glm-5.1", "credential/opencode/dev")).cli).toBe(
      "opencode",
    );
    expect(buildWriterAdapter(deps(), entry("aider", "anthropic/claude-opus-4-8", "credential/aider/dev")).cli).toBe(
      "aider",
    );
    expect(buildWriterAdapter(deps(), entry("pi", "anthropic/claude-opus-4-8", "credential/pi/dev")).cli).toBe("pi");
    expect(buildWriterAdapter(deps(), entry("reasonix", "deepseek-reasoner", "credential/reasonix/dev")).cli).toBe(
      "reasonix",
    );
  });

  it("treats pi and reasonix as Writer-only — they route for write but are not selectable Answerers", () => {
    for (const cli of ["pi", "reasonix"] as const) {
      expect(SELECTABLE_WRITER_CLIS).toContain(cli);
      expect(SELECTABLE_ANSWERER_CLIS).not.toContain(cli);
      expect(() => buildAnswererAdapter<CheckAnswer>(deps(), entry(cli, "model", `credential/${cli}/dev`))).toThrow(
        UnsupportedProviderError,
      );
    }
  });

  it("treats aider as Writer-only — it routes for write but is not a selectable Answerer", () => {
    expect(SELECTABLE_WRITER_CLIS).toContain("aider");
    expect(SELECTABLE_ANSWERER_CLIS).not.toContain("aider");
    expect(() => buildAnswererAdapter<CheckAnswer>(deps(), entry("aider", "gpt-5", "credential/aider/dev"))).toThrow(
      UnsupportedProviderError,
    );
  });

  it("resolves codex and claude answerer chain entries to the right cli", () => {
    expect(buildAnswererAdapter<CheckAnswer>(deps(), entry("codex", "gpt-5", "credential/codex/dev")).cli).toBe(
      "codex",
    );
    expect(
      buildAnswererAdapter<CheckAnswer>(deps(), entry("claude", "claude-opus-4-8", "credential/claude/dev")).cli,
    ).toBe("claude");
  });

  it("treats opencode as Writer-only — it is not a selectable Answerer", () => {
    expect(SELECTABLE_WRITER_CLIS).toContain("opencode");
    expect(SELECTABLE_ANSWERER_CLIS).not.toContain("opencode");
    expect(() =>
      buildAnswererAdapter<CheckAnswer>(deps(), entry("opencode", "zai/glm-5.1", "credential/opencode/dev")),
    ).toThrow(UnsupportedProviderError);
  });

  it("rejects an unknown provider cli for both roles", () => {
    expect(() => buildWriterAdapter(deps(), entry("wafer", "wafer-1", "credential/wafer/dev"))).toThrow(
      UnsupportedProviderError,
    );
    expect(() => buildAnswererAdapter<CheckAnswer>(deps(), entry("wafer", "wafer-1", "credential/wafer/dev"))).toThrow(
      UnsupportedProviderError,
    );
  });

  it("admits the new providers as fallback-chain entries with NO schema migration", () => {
    // The routing table parses chains mixing all three providers without any
    // shape change — confirming the claim that new providers slot into
    // the existing per-role chain (cli/model are free-form strings).
    const parsed = RoutingTable.parse({
      write: {
        chain: [
          { cli: "claude", model: "claude-opus-4-8", authRef: "credential/claude/dev" },
          { cli: "opencode", model: "zai/glm-5.1", authRef: "credential/opencode/dev" },
          { cli: "codex", model: "gpt-5", authRef: "credential/codex/dev" },
        ],
      },
      check: {
        chain: [{ cli: "claude", model: "claude-opus-4-8", authRef: "credential/claude/dev" }],
      },
    });
    expect(parsed.write.chain).toHaveLength(3);
    expect(parsed.write.chain.map((c) => c.cli)).toEqual(["claude", "opencode", "codex"]);

    // And each entry resolves through the selector.
    const d = deps();
    for (const e of parsed.write.chain) {
      expect(buildWriterAdapter(d, e).authRef).toBe(e.authRef);
    }
  });
});

describe("buildAdaptersFromRouting (the buildAdapters seam)", () => {
  it("resolves the head of each role's chain into the loop's four adapters", () => {
    const routing = RoutingTable.parse({
      plan: {
        chain: [{ cli: "claude", model: "claude-opus-4-8", authRef: "credential/claude/dev" }],
      },
      write: {
        chain: [{ cli: "opencode", model: "zai/glm-5.1", authRef: "credential/opencode/dev" }],
      },
      check: { chain: [{ cli: "codex", model: "gpt-5", authRef: "credential/codex/dev" }] },
      audit: {
        chain: [{ cli: "claude", model: "claude-opus-4-8", authRef: "credential/claude/dev" }],
      },
    });
    const adapters = buildAdaptersFromRouting(deps(), routing);
    expect(adapters.planner.cli).toBe("claude");
    expect(adapters.writer.cli).toBe("opencode");
    expect(adapters.checker.cli).toBe("codex");
    expect(adapters.auditor.cli).toBe("claude");
  });

  it("throws when a required role's chain is empty", () => {
    const routing = RoutingTable.parse({ plan: { chain: [] } });
    expect(() => buildAdaptersFromRouting(deps(), routing)).toThrow(EmptyRoutingChainError);
  });
});

// Track C §4: the selectable-cli sets are DERIVED from the harness capability
// table (harnessCapability.ts). This conformance test pins that the derivation
// reproduces today's behavior — codex/claude for both roles, opencode
// writer-only — so a future capability edit that would change selection is
// caught here, not in production.
describe("harness capability model (Track C §4 protocol contract)", () => {
  it("declares the v1 protocol version", () => {
    expect(HARNESS_PROTOCOL_VERSION).toBe("v1");
  });

  it("derives SELECTABLE_WRITER_CLIS to exactly today's writers (codex, claude, opencode, aider, pi, reasonix)", () => {
    expect([...SELECTABLE_WRITER_CLIS].toSorted()).toEqual(["aider", "claude", "codex", "opencode", "pi", "reasonix"]);
  });

  it("derives SELECTABLE_ANSWERER_CLIS to exactly today's answerers (codex, claude)", () => {
    expect([...SELECTABLE_ANSWERER_CLIS].toSorted()).toEqual(["claude", "codex"]);
  });

  it("keeps structuredOutput exactly equivalent to answer-eligibility for every harness", () => {
    for (const capability of HARNESS_CAPABILITIES) {
      expect(capability.structuredOutput).toBe(capability.roles.includes("answer"));
    }
  });

  it("classifies the two capability classes: codex/claude structured-capable, opencode writer-only", () => {
    expect(harnessSupportsRole("codex", "answer")).toBe(true);
    expect(harnessSupportsRole("claude", "answer")).toBe(true);
    expect(harnessSupportsRole("opencode", "answer")).toBe(false);
    expect(harnessSupportsRole("opencode", "write")).toBe(true);
    expect(harnessSupportsRole("aider", "answer")).toBe(false);
    expect(harnessSupportsRole("aider", "write")).toBe(true);
    expect(harnessSupportsRole("pi", "answer")).toBe(false);
    expect(harnessSupportsRole("pi", "write")).toBe(true);
    expect(harnessSupportsRole("reasonix", "answer")).toBe(false);
    expect(harnessSupportsRole("reasonix", "write")).toBe(true);
    expect(harnessSupportsRole("agy", "write")).toBe(false);
    expect(harnessSupportsRole("wafer", "write")).toBe(false);
  });
});

class NoopSsh implements CommandSubstrate {
  async run(_target: RunnerHandle, _command: RunnerCommand): Promise<CommandResult> {
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  }
}
