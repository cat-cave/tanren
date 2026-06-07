import { describe, expect, it } from "vitest";
import { DefaultLlmEntry } from "../src/engine/credentials/defaultLlmEntry.js";
import { migrateOrgConfig } from "../src/engine/config/orgConfig.js";
import { migrateProjectConfig } from "../src/engine/config/index.js";

// The DefaultLlmEntry refinement is the SCHEMA-level chokepoint: it gates EVERY
// write path (the connect route AND a generic org/project config PATCH), so an
// incompatible default cannot be persisted and later trusted by the resolver.

describe("DefaultLlmEntry validation", () => {
  it("accepts a full-role harness with a compatible credential (codex + codex bundle)", () => {
    const parsed = DefaultLlmEntry.parse({
      cli: "codex",
      model: "default",
      authRef: "credential/codex/org/o1/default",
    });
    expect(parsed.cli).toBe("codex");
  });

  it("rejects a writer-only cli as a default (aider cannot serve every role)", () => {
    expect(() =>
      DefaultLlmEntry.parse({ cli: "aider", model: "default", authRef: "credential/anthropic/org/o1/default" }),
    ).toThrow(/full-role/u);
  });

  it("accepts a full-role cli paired with a raw api_key it now consumes (codex + openrouter key)", () => {
    const parsed = DefaultLlmEntry.parse({
      cli: "codex",
      model: "default",
      authRef: "credential/openrouter/org/o1/default",
    });
    expect(parsed.cli).toBe("codex");
  });

  it("accepts claude paired with a raw Anthropic api_key (the native env-key path)", () => {
    const parsed = DefaultLlmEntry.parse({
      cli: "claude",
      model: "default",
      authRef: "credential/anthropic/org/o1/default",
    });
    expect(parsed.cli).toBe("claude");
  });

  it("rejects an authRef that is not a recognized LLM credential", () => {
    expect(() =>
      DefaultLlmEntry.parse({ cli: "codex", model: "default", authRef: "credential/github/org/o1/default" }),
    ).toThrow(/not a recognized LLM credential/u);
  });
});

describe("config schemas reject an invalid default LLM via PATCH (the bypass BLOCKING fix)", () => {
  it("org config PATCH cannot persist an incompatible default (codex cannot consume a claude bundle)", () => {
    expect(() =>
      migrateOrgConfig({
        version: 1,
        defaultCredentials: {
          defaultLlm: { cli: "codex", model: "default", authRef: "credential/claude/org/o1/x" },
        },
      }),
    ).toThrow(/cannot consume/u);
  });

  it("project config PATCH cannot persist a writer-only default", () => {
    expect(() =>
      migrateProjectConfig({
        version: 1,
        credentials: { defaultLlm: { cli: "aider", model: "default", authRef: "credential/anthropic/org/o1/x" } },
      }),
    ).toThrow(/full-role/u);
  });

  it("org config accepts a valid codex-bundle default", () => {
    const cfg = migrateOrgConfig({
      version: 1,
      defaultCredentials: {
        defaultLlm: { cli: "codex", model: "default", authRef: "credential/codex/org/o1/default" },
      },
    });
    expect(cfg.defaultCredentials?.defaultLlm?.cli).toBe("codex");
  });
});
