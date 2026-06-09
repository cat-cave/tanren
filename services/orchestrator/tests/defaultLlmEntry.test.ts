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

  it("accepts codex with the raw api_key providers it delivers (openrouter + openai-api)", () => {
    for (const slug of ["openrouter", "openai-api"]) {
      const parsed = DefaultLlmEntry.parse({
        cli: "codex",
        model: "default",
        authRef: `credential/${slug}/org/o1/default`,
      });
      expect(parsed.cli).toBe("codex");
    }
  });

  it("accepts claude paired with a raw Anthropic api_key (the native env-key path)", () => {
    const parsed = DefaultLlmEntry.parse({
      cli: "claude",
      model: "default",
      authRef: "credential/anthropic/org/o1/default",
    });
    expect(parsed.cli).toBe("claude");
  });

  it("REJECTS codex + an anthropic api_key (codex cannot deliver an anthropic key)", () => {
    expect(() =>
      DefaultLlmEntry.parse({ cli: "codex", model: "default", authRef: "credential/anthropic/org/o1/default" }),
    ).toThrow(/cannot deliver a .*anthropic.* api_key/u);
  });

  it("REJECTS claude + an openrouter api_key (claude cannot deliver an openrouter key)", () => {
    expect(() =>
      DefaultLlmEntry.parse({ cli: "claude", model: "default", authRef: "credential/openrouter/org/o1/default" }),
    ).toThrow(/cannot deliver a .*openrouter.* api_key/u);
  });

  it("REJECTS claude + an openai-api api_key (claude cannot deliver an openai key)", () => {
    expect(() =>
      DefaultLlmEntry.parse({ cli: "claude", model: "default", authRef: "credential/openai-api/org/o1/default" }),
    ).toThrow(/cannot deliver a .*openai-api.* api_key/u);
  });

  it("rejects an authRef that is not a recognized LLM credential", () => {
    expect(() =>
      DefaultLlmEntry.parse({ cli: "codex", model: "default", authRef: "credential/github/org/o1/default" }),
    ).toThrow(/not a recognized LLM credential/u);
  });

  it("rejects a well-prefixed but MALFORMED ref at write (the apex v29 BYOK-Codex gap)", () => {
    // A `credential/codex/…` ref with a doubled-slash (empty trailing segment)
    // would pass the slug/credential-type checks (slug is `codex`) but crash the
    // RUN deep in the materializer with the format error. The schema chokepoint
    // now rejects it where it is SET — LOUD, not mid-run.
    expect(() =>
      DefaultLlmEntry.parse({ cli: "codex", model: "default", authRef: "credential/codex/org/o1//default" }),
    ).toThrow(/invalid credential ref format/u);
    // A valid BYOK-Codex ref still parses.
    const ok = DefaultLlmEntry.parse({ cli: "codex", model: "default", authRef: "credential/codex/org/o1/default" });
    expect(ok.authRef).toBe("credential/codex/org/o1/default");
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

  it("org config PATCH cannot persist a slug-incompatible api_key default (codex + anthropic key)", () => {
    expect(() =>
      migrateOrgConfig({
        version: 1,
        defaultCredentials: {
          defaultLlm: { cli: "codex", model: "default", authRef: "credential/anthropic/org/o1/x" },
        },
      }),
    ).toThrow(/cannot deliver a .*anthropic.* api_key/u);
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
