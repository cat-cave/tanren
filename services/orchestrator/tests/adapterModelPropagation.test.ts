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
import { createAiderWriter } from "../src/engine/providers/aider.js";
import { createClaudeAnswerer, createClaudeWriter } from "../src/engine/providers/claude.js";
import { createCodexAnswerer, createCodexWriter } from "../src/engine/providers/codex.js";
import { CODEX_OPENROUTER_MODEL } from "../src/engine/providers/codexModel.js";
import { createOpencodeWriter, resolveOpencodeModel } from "../src/engine/providers/opencode.js";
import { createPiWriter } from "../src/engine/providers/pi.js";
import { createReasonixWriter } from "../src/engine/providers/reasonix.js";
import type { AnswererAdapter, WriterAdapter } from "../src/engine/providers/types.js";

// aider's and pi's pinned default. Both keep it module-private, so it is restated
// here rather than exported purely for a test: a deliberate change to either
// default must show up as a change to this line too.
const DEFAULT_CHAIN_MODEL = "anthropic/claude-opus-4-8";

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

// EVERY production adapter, not just codex.
//
// Making `model` OPTIONAL on the adapter interface is what lets the ~40 test
// fixtures stay untouched — and it is also what let the other five production
// adapters typecheck without declaring it at all. Each of them resolves a concrete
// model id INSIDE `runWriter` (a default constant, or opencode's managed
// namespacing) and then throws it away: the value never reaches the adapter object
// the cost path reads. Those routes therefore recorded `cost_records.model = ''`
// and notional reason `model_id_absent` — the code whose own operator text calls it
// "a TANREN DEFECT" — on 100% of calls.
//
// The contract pinned here is narrow and exact: the id on the adapter must be the
// id the CLI is actually told to use, and where the CLI is told nothing the adapter
// must say nothing rather than invent an id it was not billed at.
describe("every production adapter declares the model id its command pins", () => {
  const DEPS = {
    secrets: { get: async () => "sk-test" },
    ssh: { run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) },
    target: { host: "runner", user: "tanren" },
    runId: "run-1",
    credentialRef: "credential/openrouter/default",
  } as unknown as Record<string, unknown>;

  const build = <T>(factory: (deps: never) => T, extra: Record<string, unknown> = {}): T =>
    factory({ ...DEPS, ...extra } as never);

  it("aider defaults to the pinned model, and an explicit chain model wins", () => {
    expect(build(createAiderWriter).model).toBe(DEFAULT_CHAIN_MODEL);
    expect(build(createAiderWriter, { model: "openai/gpt-5.6-luna" }).model).toBe("openai/gpt-5.6-luna");
  });

  it("pi defaults to the pinned model, and an explicit chain model wins", () => {
    expect(build(createPiWriter).model).toBe(DEFAULT_CHAIN_MODEL);
    expect(build(createPiWriter, { model: "openai/gpt-5.6-luna" }).model).toBe("openai/gpt-5.6-luna");
  });

  it("opencode applies the SAME managed namespacing its --model flag gets", () => {
    // Direct: the bare marketplace slug. Managed (an endpoint override): namespaced
    // under `openrouter/`. Recording the bare id on a managed run would miss the
    // OpenRouter price table by exactly one prefix and report `model_not_listed`.
    expect(build(createOpencodeWriter).model).toBe(resolveOpencodeModel(undefined, false));
    expect(build(createOpencodeWriter, { endpointBaseUrl: "https://openrouter.ai/api/v1" }).model).toBe(
      resolveOpencodeModel(undefined, true),
    );
    expect(build(createOpencodeWriter, { endpointBaseUrl: "https://openrouter.ai/api/v1" }).model).toMatch(
      /^openrouter\//u,
    );
  });

  it("claude forwards an explicit model and stays ABSENT when the CLI picks its own", () => {
    expect(build(createClaudeWriter, { model: "claude-opus-4-8" }).model).toBe("claude-opus-4-8");
    // `in`, not `toBeUndefined()` — see the decorator tests above: a present key
    // holding undefined is a different thing from an absent one.
    expect("model" in build(createClaudeWriter)).toBe(false);
  });

  it("the claude ANSWERER carries the same id as its writer", () => {
    const answerer = createClaudeAnswerer<unknown>({
      ...DEPS,
      model: "claude-opus-4-8",
      parse: (raw: string) => raw,
      schema: {},
    } as unknown as Parameters<typeof createClaudeAnswerer>[0]);
    expect(answerer.model).toBe("claude-opus-4-8");
  });

  it("reasonix forwards an explicit model and stays ABSENT when it defaults", () => {
    expect(build(createReasonixWriter, { model: "deepseek-reasoner" }).model).toBe("deepseek-reasoner");
    expect("model" in build(createReasonixWriter)).toBe(false);
  });
});
