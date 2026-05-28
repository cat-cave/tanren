import { describe, expect, it } from "vitest";
import { RoutingChainEntry, RoutingTable } from "../src/engine/config/shared.js";
import type { SshTarget } from "../src/engine/contracts/allocator.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import type { SshCommand, SshCommandResult, SshSubstrate } from "../src/engine/contracts/sshSubstrate.js";
import {
  buildAdaptersFromRouting,
  buildAnswererAdapter,
  buildWriterAdapter,
  EmptyRoutingChainError,
  SELECTABLE_ANSWERER_CLIS,
  SELECTABLE_WRITER_CLIS,
  UnsupportedProviderError
} from "../src/engine/providers/adapterSelector.js";
import type { CheckAnswer } from "../src/engine/providers/answererSchemas.js";

const target: SshTarget = {
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity"
};

function deps() {
  return { secrets: new InMemorySecretStore(), ssh: new NoopSsh(), target, runId: "run_sel_1" };
}

function entry(cli: string, model: string, authRef: string): RoutingChainEntry {
  return RoutingChainEntry.parse({ cli, model, authRef });
}

describe("adapter selector (P3-0012 fallback-chain resolution)", () => {
  it("resolves codex, claude, and opencode writer chain entries to the right cli", () => {
    expect(buildWriterAdapter(deps(), entry("codex", "gpt-5", "credential/codex/dev")).cli).toBe("codex");
    expect(buildWriterAdapter(deps(), entry("claude", "claude-opus-4-8", "credential/claude/dev")).cli).toBe("claude");
    expect(buildWriterAdapter(deps(), entry("opencode", "zai/glm-5.1", "credential/opencode/dev")).cli).toBe("opencode");
  });

  it("resolves codex and claude answerer chain entries to the right cli", () => {
    expect(buildAnswererAdapter<CheckAnswer>(deps(), entry("codex", "gpt-5", "credential/codex/dev")).cli).toBe("codex");
    expect(buildAnswererAdapter<CheckAnswer>(deps(), entry("claude", "claude-opus-4-8", "credential/claude/dev")).cli).toBe("claude");
  });

  it("treats opencode as Writer-only — it is not a selectable Answerer", () => {
    expect(SELECTABLE_WRITER_CLIS).toContain("opencode");
    expect(SELECTABLE_ANSWERER_CLIS).not.toContain("opencode");
    expect(() => buildAnswererAdapter<CheckAnswer>(deps(), entry("opencode", "zai/glm-5.1", "credential/opencode/dev"))).toThrow(
      UnsupportedProviderError
    );
  });

  it("rejects an unknown provider cli for both roles", () => {
    expect(() => buildWriterAdapter(deps(), entry("wafer", "wafer-1", "credential/wafer/dev"))).toThrow(UnsupportedProviderError);
    expect(() => buildAnswererAdapter<CheckAnswer>(deps(), entry("wafer", "wafer-1", "credential/wafer/dev"))).toThrow(
      UnsupportedProviderError
    );
  });

  it("admits the new providers as fallback-chain entries with NO schema migration", () => {
    // The routing table parses chains mixing all three providers without any
    // shape change — confirming P2A-0006's claim that new providers slot into
    // the existing per-role chain (cli/model are free-form strings).
    const parsed = RoutingTable.parse({
      write: {
        chain: [
          { cli: "claude", model: "claude-opus-4-8", authRef: "credential/claude/dev" },
          { cli: "opencode", model: "zai/glm-5.1", authRef: "credential/opencode/dev" },
          { cli: "codex", model: "gpt-5", authRef: "credential/codex/dev" }
        ]
      },
      check: { chain: [{ cli: "claude", model: "claude-opus-4-8", authRef: "credential/claude/dev" }] }
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
      plan: { chain: [{ cli: "claude", model: "claude-opus-4-8", authRef: "credential/claude/dev" }] },
      write: { chain: [{ cli: "opencode", model: "zai/glm-5.1", authRef: "credential/opencode/dev" }] },
      check: { chain: [{ cli: "codex", model: "gpt-5", authRef: "credential/codex/dev" }] },
      audit: { chain: [{ cli: "claude", model: "claude-opus-4-8", authRef: "credential/claude/dev" }] }
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

class NoopSsh implements SshSubstrate {
  async run(_target: SshTarget, _command: SshCommand): Promise<SshCommandResult> {
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  }
}
