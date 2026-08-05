// REGRESSION (XHE-931): the model id must survive the observability decorators.
//
// `adapterSelector` NEVER hands a bare adapter to the workflow — every writer and
// answerer is wrapped in `timedWriterAdapter` / `timedAnswererAdapter` before it is
// returned. Those decorators rebuild the adapter as a fresh object literal, so any
// field they forget to copy is silently dropped on 100% of production calls.
//
// `model` was forgotten. `createCodexWriter` sets it correctly from
// `recordedCodexModel`, the eight cost call sites read `adapter.model ?? ""`, and
// every one of them read `""` — because the instance the workflow holds is the
// decorator, not the codex adapter. That is why a live `cost.resolved` payload
// carries `"model": ""` on a codex/OpenRouter route whose config.toml pins
// `openai/gpt-5.6-luna`, and why `notional_cost_usd` is NULL on every row.
//
// The unit tests for the decorators only ever asserted timing, and the unit tests
// for the codex adapter only ever built it directly — so the seam BETWEEN them,
// which is the only seam production uses, was untested in both directions.
import { describe, expect, it } from "vitest";

import { timedAnswererAdapter, timedWriterAdapter } from "../src/engine/observability/index.js";
import { createCodexAnswerer, createCodexWriter } from "../src/engine/providers/codex.js";
import { CODEX_OPENROUTER_MODEL } from "../src/engine/providers/codexModel.js";
import type { AnswererAdapter, WriterAdapter } from "../src/engine/providers/types.js";

// A BYOK OpenRouter route — the deployment shape this regression was found on.
const OPENROUTER_DEPS = {
  secrets: { get: async () => "sk-test" },
  ssh: { run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) },
  target: { host: "runner", user: "tanren" },
  runId: "run-1",
  credentialRef: "credential/openrouter/default",
} as unknown as Parameters<typeof createCodexWriter>[0];

describe("adapter model propagation through the observability decorators", () => {
  it("the codex WRITER declares the OpenRouter-namespaced model id", () => {
    // Sanity: the inner adapter is not the problem.
    const inner: WriterAdapter = createCodexWriter(OPENROUTER_DEPS);
    expect(inner.model).toBe(CODEX_OPENROUTER_MODEL);
  });

  it("timedWriterAdapter PRESERVES the model id (production reads the decorator)", () => {
    const inner: WriterAdapter = createCodexWriter(OPENROUTER_DEPS);
    const wrapped: WriterAdapter = timedWriterAdapter(inner, () => {});
    // The cost path reads exactly this, as `adapter.model ?? ""`.
    expect(wrapped.model).toBe(CODEX_OPENROUTER_MODEL);
    expect(wrapped.model ?? "").not.toBe("");
  });

  it("the codex ANSWERER declares the OpenRouter-namespaced model id", () => {
    const inner = createCodexAnswerer<unknown>({
      ...(OPENROUTER_DEPS as object),
      parse: (raw: string) => raw,
      schema: {},
    } as unknown as Parameters<typeof createCodexAnswerer>[0]);
    expect(inner.model).toBe(CODEX_OPENROUTER_MODEL);
  });

  it("timedAnswererAdapter PRESERVES the model id", () => {
    const inner = createCodexAnswerer<unknown>({
      ...(OPENROUTER_DEPS as object),
      parse: (raw: string) => raw,
      schema: {},
    } as unknown as Parameters<typeof createCodexAnswerer>[0]);
    const wrapped: AnswererAdapter<unknown> = timedAnswererAdapter(inner, "checker", () => {});
    expect(wrapped.model).toBe(CODEX_OPENROUTER_MODEL);
    expect(wrapped.model ?? "").not.toBe("");
  });

  it("a decorator forwards an ABSENT model as absent, not as a fabricated id", () => {
    // Non-vacuous guard: the fix must forward what the inner adapter declares,
    // including nothing. A decorator that hardcoded a default would pass the tests
    // above while lying about a fixture that genuinely has no model.
    //
    // Asserted with `in`, NOT `toBeUndefined()`. Mutation testing caught that:
    // dropping the spread condition yields `{ model: undefined }`, which is a
    // PRESENT key holding undefined — indistinguishable from absent to
    // `toBeUndefined()`, so the mutant survived and this "guard" proved vacuous.
    // Presence is the thing being asserted, so presence is what the test must read.
    const fake: WriterAdapter = {
      kind: "writer",
      cli: "fake",
      authRef: "credential/openrouter/default",
      runWriter: async () => ({ ok: true }) as never,
    };
    const wrapped = timedWriterAdapter(fake, () => {});
    expect("model" in wrapped).toBe(false);
    expect(Object.keys(wrapped)).not.toContain("model");
  });

  it("the ANSWERER decorator likewise omits an absent model rather than keying it undefined", () => {
    const fake = {
      kind: "answerer" as const,
      cli: "fake" as const,
      authRef: "credential/openrouter/default",
      runAnswerer: async () => ({}) as never,
    };
    const wrapped = timedAnswererAdapter(fake as never, "checker", () => {});
    expect("model" in wrapped).toBe(false);
  });

  it("the answerer decorator omits lastTokenUsage when the inner adapter has none", () => {
    // Same present-vs-absent hazard on the sibling spread-conditional, which the
    // prior tests only ever exercised in its present form.
    const fake = {
      kind: "answerer" as const,
      cli: "fake" as const,
      authRef: "credential/openrouter/default",
      runAnswerer: async () => ({}) as never,
    };
    expect("lastTokenUsage" in timedAnswererAdapter(fake as never, "checker", () => {})).toBe(false);
  });

  it("the answerer decorator FORWARDS lastTokenUsage when the inner adapter has one", () => {
    const usage = { inputTokens: 1, totalTokens: 1 };
    const fake = {
      kind: "answerer" as const,
      cli: "codex" as const,
      authRef: "credential/openrouter/default",
      model: "openai/gpt-5.6-luna",
      lastTokenUsage: () => usage,
      runAnswerer: async () => ({}) as never,
    };
    const wrapped = timedAnswererAdapter(fake as never, "checker", () => {});
    expect(wrapped.lastTokenUsage?.()).toBe(usage);
    expect(wrapped.model).toBe("openai/gpt-5.6-luna");
  });
});
