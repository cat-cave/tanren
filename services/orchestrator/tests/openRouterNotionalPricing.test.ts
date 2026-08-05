// XHE-931 — the notional axis, end to end, on the route this deployment runs.
//
// THE MEASUREMENT THIS TEST EXISTS FOR. A live `cost.resolved` from the running
// writer:
//   { cli: "codex", model: "", provider: "openrouter",
//     costUsd: null, notionalCostUsd: null, costBasis: "unknown" }
// 46 rows, 46 null costs, 100% unattributed against a ≤5% criterion. BOTH halves of
// the owner's "belt and suspenders" were dead: no metered cost (upstream, §meterability)
// and no NOTIONAL cost either — which is the half that was supposed to still work.
//
// Three independent defects produced that single null, and each gets a test here:
//   D1  the observability decorators dropped `WriterAdapter.model`, so every row
//       recorded `model: ""`                     (adapterModelPropagation.test.ts)
//   D2  the only price source was LiteLLM, which does not list — under ANY key —
//       the marketplace id tanren sends OpenRouter
//   D3  the loud-event guard required `model !== ""`, so D1 was SILENT: the one
//       state most worth alarming on was the one state that could not alarm
//
// Token counts below are the REAL counters from a codex `turn.completed` (see
// docs/_design/openrouter-cost-attribution.md §1), and rates are the REAL live
// OpenRouter quote for `openai/gpt-5.6-luna` captured 2026-08-04.
import { describe, expect, it } from "vitest";

import { CostRecorder } from "../src/engine/costs/index.js";
import { CompositeModelPriceSource } from "../src/engine/costs/pricing/compositePriceSource.js";
import { ModelPriceSource } from "../src/engine/costs/pricing/modelPriceSource.js";
import { normalizeOpenRouterModels } from "../src/engine/costs/pricing/openRouterPriceSource.js";
import { computeNotionalUsd, LoudNotionalReason, NotionalReason } from "../src/engine/costs/notional.js";
import { resolveCostSource } from "../src/engine/costs/sources.js";
import { NotionalReason as EventNotionalReason } from "../src/engine/events/schemas/infra.js";
import type { TokenUsage } from "../src/engine/providers/types.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";

// VERBATIM live OpenRouter catalogue entry (2026-08-04).
const LIVE_CATALOGUE = {
  data: [
    {
      id: "openai/gpt-5.6-luna",
      pricing: {
        prompt: "0.0000001",
        completion: "0.0000006",
        input_cache_read: "0.00000001",
        input_cache_write: "0.000000125",
        overrides: [
          {
            min_prompt_tokens: 272000,
            prompt: "0.0000002",
            completion: "0.0000009",
            input_cache_read: "0.00000002",
            input_cache_write: "0.00000025",
          },
        ],
      },
    },
  ],
};

// The LiteLLM table, as it really is: 2 749 models, and NOT ONE of them keyed
// `openai/gpt-5.6-luna`. Verified against the vendored snapshot — a search for
// "luna" returns only `deepinfra/Sao10K/L3-8B-Lunaris-v1-Turbo` and
// `novita/sao10k/l3-8b-lunaris`. This fixture stands in for "reachable, and does
// not list it".
const LITELLM_WITHOUT_LUNA = new ModelPriceSource({
  "gpt-5.6-luna": { litellm_provider: "openai", input_cost_per_token: 5e-6, output_cost_per_token: 1e-5 },
});

// Built lazily (see openRouterPriceSource.test.ts): a module-scope call to the code
// under test turns a mutation inside it into a COLLECTION failure, which reads as an
// unattributable "survived" mutant instead of a kill.
function makePriceSource(): CompositeModelPriceSource {
  return new CompositeModelPriceSource(
    new ModelPriceSource(normalizeOpenRouterModels(LIVE_CATALOGUE)),
    LITELLM_WITHOUT_LUNA,
  );
}

function usage(partial: Partial<TokenUsage>): TokenUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    ...partial,
  };
}

// The real codex `turn.completed.usage`, de-overlapped the way
// `tokenUsageFromRecord` does it: input 17 665 includes 11 008 cached.
const REAL_CODEX_TURN = usage({
  inputTokens: 17665 - 11008,
  cachedInputTokens: 11008,
  outputTokens: 5,
  totalTokens: 17670,
});

const OPENROUTER_SOURCE = resolveCostSource({
  cli: "codex",
  authRef: "credential/openrouter/default",
  model: "openai/gpt-5.6-luna",
  realProviderCostUsd: null,
  ccusageCostUsd: null,
  rawUsage: {},
});

describe("D2 — the notional axis is priced from OpenRouter's OWN live quote", () => {
  it("prices the real codex turn that LiteLLM could only ever null", () => {
    const { usd, reason } = computeNotionalUsd(OPENROUTER_SOURCE, REAL_CODEX_TURN, makePriceSource());
    expect(reason).toBe("priced");
    // 6 657 uncached prompt @ $0.1/M + 11 008 cached @ $0.01/M + 5 out @ $0.6/M.
    const expected = (6657 * 0.1) / 1e6 + (11008 * 0.01) / 1e6 + (5 * 0.6) / 1e6;
    expect(usd).toBe(expected.toFixed(6));
    expect(Number(usd)).toBeGreaterThan(0);
  });

  it("NEGATIVE CONTROL: the same call against LiteLLM ALONE is null, as it is today", () => {
    // Proves the fixture is not rigged and that the LiteLLM leg genuinely cannot
    // serve this route — the composite's OpenRouter leg is doing the work.
    const { usd, reason } = computeNotionalUsd(OPENROUTER_SOURCE, REAL_CODEX_TURN, LITELLM_WITHOUT_LUNA);
    expect(usd).toBeNull();
    expect(reason).toBe("model_not_listed");
  });

  it("bills a long-context call at the marketplace's HIGHER tier", () => {
    // 300 000 prompt tokens crosses OpenRouter's 272 000 floor: prompt doubles to
    // $0.2/M and completion rises to $0.9/M. Ignoring tiers would under-state this
    // call by ~2x — on exactly the long-context calls an agent harness makes most.
    const long = usage({ inputTokens: 300_000, outputTokens: 1_000, totalTokens: 301_000 });
    const { usd } = computeNotionalUsd(OPENROUTER_SOURCE, long, makePriceSource());
    const tiered = (300_000 * 0.2) / 1e6 + (1_000 * 0.9) / 1e6;
    expect(usd).toBe(tiered.toFixed(6));
    // And it is strictly more than the flat rate would have charged.
    const flat = (300_000 * 0.1) / 1e6 + (1_000 * 0.6) / 1e6;
    expect(Number(usd)).toBeGreaterThan(flat);
  });

  it("the tier floor is measured against ALL prompt buckets, not inputTokens alone", () => {
    // Tanren stores prompt tokens in three disjoint buckets. A call with 200k
    // uncached + 100k cached is a 300k-prompt call and must cross the 272k floor,
    // even though `inputTokens` alone (200k) does not.
    const split = usage({ inputTokens: 200_000, cachedInputTokens: 100_000, outputTokens: 0, totalTokens: 300_000 });
    const { usd } = computeNotionalUsd(OPENROUTER_SOURCE, split, makePriceSource());
    const tiered = (200_000 * 0.2) / 1e6 + (100_000 * 0.02) / 1e6;
    expect(usd).toBe(tiered.toFixed(6));
  });

  it("stays on the base tier just below the floor (the boundary is not off by one)", () => {
    const below = usage({ inputTokens: 271_999, totalTokens: 271_999 });
    const at = usage({ inputTokens: 272_000, totalTokens: 272_000 });
    expect(computeNotionalUsd(OPENROUTER_SOURCE, below, makePriceSource()).usd).toBe(
      ((271_999 * 0.1) / 1e6).toFixed(6),
    );
    expect(computeNotionalUsd(OPENROUTER_SOURCE, at, makePriceSource()).usd).toBe(((272_000 * 0.2) / 1e6).toFixed(6));
  });
});

describe("the reason enum does not drift between the cost engine and the event vocabulary", () => {
  it("NotionalReason is identical in notional.ts and the event schema", () => {
    // `events/schemas/infra.ts` deliberately MIRRORS the enum rather than
    // importing from the cost engine, because the event vocabulary must not depend
    // on it — the same rule `costFailures.ts` follows for UnmeterableReason.
    // A mirror can drift, and a
    // drifted mirror would reject a valid payload at RUNTIME, dropping the very
    // event that explains a null. This test makes drift fail here instead.
    expect([...EventNotionalReason.options].sort()).toEqual([...NotionalReason.options].sort());
  });

  it("every loud reason is a member of the full reason enum", () => {
    for (const loud of LoudNotionalReason.options) {
      expect(NotionalReason.options).toContain(loud);
    }
  });
});

describe("D3 — every null notional carries a reason, and the actionable ones are loud", () => {
  const cases: ReadonlyArray<[string, ReturnType<typeof resolveCostSource>, TokenUsage, string]> = [
    [
      "a real call with NO model id -> a DEFECT rather than an empty row",
      resolveCostSource({ ...OPENROUTER_SOURCE, model: "", cli: "codex", authRef: "credential/openrouter/default" }),
      REAL_CODEX_TURN,
      "model_id_absent",
    ],
    ["a zero-token call is honestly empty, not a gap", OPENROUTER_SOURCE, usage({ totalTokens: 0 }), "no_tokens"],
    [
      "an unrecognized credential is untrustworthy on both axes",
      resolveCostSource({
        cli: "codex",
        authRef: "not-a-credential-ref",
        model: "openai/gpt-5.6-luna",
        realProviderCostUsd: null,
        ccusageCostUsd: null,
        rawUsage: {},
      }),
      REAL_CODEX_TURN,
      "unattributed_credential",
    ],
  ];

  for (const [name, source, tokens, expected] of cases) {
    it(`${name}`, () => {
      expect(computeNotionalUsd(source, tokens, makePriceSource()).reason).toBe(expected);
    });
  }

  it("prices a call whose provider-reported totalTokens contradicts its buckets", () => {
    // `totalTokens` is an INDEPENDENT provider-reported field, not a derived sum. A
    // provider (or a parser regression) reporting 0 alongside real buckets must not
    // turn a billable call into a silent `no_tokens`. Judged on the buckets.
    const contradictory = usage({ inputTokens: 10_000, outputTokens: 500, totalTokens: 0 });
    const { usd, reason } = computeNotionalUsd(OPENROUTER_SOURCE, contradictory, makePriceSource());
    expect(reason).toBe("priced");
    expect(Number(usd)).toBeCloseTo((10_000 * 0.1) / 1e6 + (500 * 0.6) / 1e6, 10);
  });

  it("still reports no_tokens when every billable bucket really is zero", () => {
    // Non-vacuous counterpart: the branch must not become unreachable.
    const empty = usage({ totalTokens: 12_345 });
    expect(computeNotionalUsd(OPENROUTER_SOURCE, empty, makePriceSource()).reason).toBe("no_tokens");
  });

  it("distinguishes an OUTAGE from an unlisted model — the two nulls are not the same", () => {
    // This distinction is the point of `health()`. A network fault must not be
    // recorded as a fact about the model, because the row is still repriceable.
    const noSourceReachable = new CompositeModelPriceSource(new ModelPriceSource({}), new ModelPriceSource({}));
    expect(computeNotionalUsd(OPENROUTER_SOURCE, REAL_CODEX_TURN, noSourceReachable).reason).toBe(
      "price_source_unavailable",
    );
    // Same null, same inputs, a reachable source → a different, correct reason.
    expect(computeNotionalUsd(OPENROUTER_SOURCE, REAL_CODEX_TURN, LITELLM_WITHOUT_LUNA).reason).toBe(
      "model_not_listed",
    );
  });
});

// Narrow an optional recorded event / insert to a plain record, failing the test
// loudly if it is absent rather than short-circuiting an assertion into a pass.
function payloadOf(event: { payload: unknown } | undefined): Record<string, unknown> {
  expect(event).toBeDefined();
  return (event as { payload: Record<string, unknown> }).payload;
}

function rawCostSource(params: ReadonlyArray<unknown> | undefined): Record<string, unknown> {
  expect(params).toBeDefined();
  return JSON.parse(String((params as ReadonlyArray<unknown>)[COST_SOURCE_RAW])) as Record<string, unknown>;
}

// Run-scoped insert params: 0=task, 1=run, 2=project, then commonParams from 3 —
// 12=cost_usd, 13=notional_cost_usd, 14=billing_mode, 15=cost_basis,
// 16=cost_source_raw, 17=user_id.
const COST_SOURCE_RAW = 16;
const NOTIONAL = 13;

describe("D1+D3 — the recorder records the reason and alarms on the gap", () => {
  class FakeCostPool {
    readonly inserts: Array<ReadonlyArray<unknown>> = [];
    async query(sql: string, params: ReadonlyArray<unknown> = []) {
      if (sql.trim().startsWith("INSERT INTO cost_records")) {
        this.inserts.push(params);
      }
      return { rows: [], rowCount: 1 };
    }
  }
  const baseContext = {
    runId: "run_test",
    taskId: "task_test",
    specId: "spec_test",
    projectId: "project_test",
    cli: "codex" as const,
    authRef: "credential/openrouter/default",
  };

  async function record(model: string, tokens: TokenUsage, source = makePriceSource()) {
    const pool = new FakeCostPool();
    const events = new FakeEventStore();
    const recorder = new CostRecorder(pool as never, events, undefined, undefined, source);
    const result = await recorder.record({ ...baseContext, model }, tokens);
    return { pool, events, result };
  }

  it("a priced call records the figure AND reason 'priced'", async () => {
    const { pool, events } = await record("openai/gpt-5.6-luna", REAL_CODEX_TURN);
    expect(Number(pool.inserts.at(0)?.[NOTIONAL])).toBeGreaterThan(0);
    expect(rawCostSource(pool.inserts.at(0))["notionalReason"]).toBe("priced");
    // No alarm on a healthy row.
    expect(events.events.map((e) => e.eventType)).not.toContain("cost.notional_unpriced");
  });

  it("REGRESSION D3: a model-less real call now ALARMS (it used to be silent)", async () => {
    // Before this change the guard was `context.model !== ""`, so this exact row —
    // the 100%-of-production row — emitted nothing at all.
    const { pool, events } = await record("", REAL_CODEX_TURN);
    const unpriced = events.events.filter((e) => e.eventType === "cost.notional_unpriced");
    expect(unpriced).toHaveLength(1);
    expect(payloadOf(unpriced.at(0))["reasonCode"]).toBe("model_id_absent");
    // And the row itself says why, queryably.
    expect(rawCostSource(pool.inserts.at(0))["notionalReason"]).toBe("model_id_absent");
  });

  it("stamps notionalReason on cost.resolved for EVERY row, priced or not", async () => {
    for (const [model, expected] of [
      ["openai/gpt-5.6-luna", "priced"],
      ["", "model_id_absent"],
    ] as const) {
      const { events } = await record(model, REAL_CODEX_TURN);
      const resolved = events.events.find((e) => e.eventType === "cost.resolved");
      expect(payloadOf(resolved)["notionalReason"]).toBe(expected);
    }
  });

  it("does NOT alarm on a legitimately-empty zero-token row", async () => {
    // Precision guard: the alarm must stay worth reading.
    const { events } = await record("openai/gpt-5.6-luna", usage({ totalTokens: 0 }));
    expect(events.events.map((e) => e.eventType)).not.toContain("cost.notional_unpriced");
  });

  it("alarms with 'price_source_unavailable' when no source can be reached", async () => {
    const dead = new CompositeModelPriceSource(new ModelPriceSource({}), new ModelPriceSource({}));
    const { events } = await record("openai/gpt-5.6-luna", REAL_CODEX_TURN, dead);
    const unpriced = events.events.find((e) => e.eventType === "cost.notional_unpriced");
    expect(payloadOf(unpriced)["reasonCode"]).toBe("price_source_unavailable");
  });
});
