import { describe, expect, it } from "vitest";
import { findOpenRouterGenerationId, foldGenerationId } from "../src/engine/providers/openRouterGenerationId.js";
import { parseCodexJsonlTelemetry } from "../src/engine/providers/codex.js";
import { parseClaudeStreamTelemetry } from "../src/engine/providers/claude.js";
import { parseOpencodeStreamTelemetry } from "../src/engine/providers/opencode.js";
import { emptyTokenUsage, type TokenUsage } from "../src/engine/providers/types.js";

describe("findOpenRouterGenerationId", () => {
  it("recognizes a top-level gen- prefixed id under id / response_id / generation_id", () => {
    expect(findOpenRouterGenerationId({ id: "gen-abc" })).toBe("gen-abc");
    expect(findOpenRouterGenerationId({ response_id: "gen-xyz" })).toBe("gen-xyz");
    expect(findOpenRouterGenerationId({ generation_id: "gen-123" })).toBe("gen-123");
  });

  it("finds a gen- id nested under response / generation", () => {
    expect(findOpenRouterGenerationId({ response: { id: "gen-nested" } })).toBe("gen-nested");
    expect(findOpenRouterGenerationId({ generation: { generation_id: "gen-deep" } })).toBe("gen-deep");
  });

  it("does NOT mistake a non-gen- id for an OpenRouter generation id (BYOK / internal event id)", () => {
    expect(findOpenRouterGenerationId({ id: "msg_internal_42" })).toBeUndefined();
    expect(findOpenRouterGenerationId({ id: 12345 })).toBeUndefined();
    expect(findOpenRouterGenerationId({})).toBeUndefined();
  });
});

describe("foldGenerationId", () => {
  it("folds the id onto existing token usage", () => {
    const folded = foldGenerationId({ ...emptyTokenUsage, inputTokens: 5 }, "gen-1");
    expect(folded).toMatchObject({ inputTokens: 5, openRouterGenerationId: "gen-1" });
  });

  it("mints zero-token usage carrying the id when usage is absent", () => {
    expect(foldGenerationId(undefined, "gen-2")).toMatchObject({ ...emptyTokenUsage, openRouterGenerationId: "gen-2" });
  });

  it("returns the usage unchanged (no id field) when no id surfaced", () => {
    const noId: string | undefined = undefined;
    const noUsage: TokenUsage | undefined = undefined;
    expect(foldGenerationId({ ...emptyTokenUsage, inputTokens: 1 }, noId)).toEqual({
      ...emptyTokenUsage,
      inputTokens: 1,
    });
    expect(foldGenerationId(noUsage, noId)).toBeUndefined();
  });
});

describe("managed adapter telemetry surfaces the OpenRouter generation id", () => {
  it("codex JSONL: a top-level gen- id rides onto tokenUsage", () => {
    const stdout = [
      JSON.stringify({ id: "gen-codex-1" }),
      JSON.stringify({ usage: { input_tokens: 10, output_tokens: 5 } }),
    ].join("\n");
    const telemetry = parseCodexJsonlTelemetry(stdout);
    expect(telemetry.openRouterGenerationId).toBe("gen-codex-1");
    expect(telemetry.tokenUsage?.openRouterGenerationId).toBe("gen-codex-1");
  });

  it("claude stream: a top-level gen- id rides onto tokenUsage", () => {
    const stdout = JSON.stringify({ id: "gen-claude-1", usage: { input_tokens: 1, output_tokens: 1 } });
    const telemetry = parseClaudeStreamTelemetry(stdout);
    expect(telemetry.openRouterGenerationId).toBe("gen-claude-1");
    expect(telemetry.tokenUsage?.openRouterGenerationId).toBe("gen-claude-1");
  });

  it("opencode stream: a top-level gen- id rides onto tokenUsage", () => {
    const stdout = JSON.stringify({ id: "gen-oc-1", usage: { input_tokens: 1, output_tokens: 1 } });
    const telemetry = parseOpencodeStreamTelemetry(stdout);
    expect(telemetry.openRouterGenerationId).toBe("gen-oc-1");
    expect(telemetry.tokenUsage?.openRouterGenerationId).toBe("gen-oc-1");
  });

  it("a BYOK run (no gen- id) leaves tokenUsage without an openRouterGenerationId", () => {
    const stdout = JSON.stringify({ id: "msg_42", usage: { input_tokens: 1, output_tokens: 1 } });
    const telemetry = parseCodexJsonlTelemetry(stdout);
    expect(telemetry.openRouterGenerationId).toBeUndefined();
    expect(telemetry.tokenUsage?.openRouterGenerationId).toBeUndefined();
  });
});
