import { describe, expect, it } from "vitest";
import { parseCcusageAccounting } from "../src/engine/usage/ccusageParser.js";

// The real `ccusage codex --json` shape: disjoint token buckets (input
// EXCLUDES cache) at both the daily and totals level, plus a per-model
// breakdown. Subscriptions usually report costUSD 0.
const realCcusageOutput = JSON.stringify({
  daily: [
    {
      date: "2026-05-27",
      inputTokens: 1000,
      outputTokens: 200,
      cachedInputTokens: 500,
      reasoningOutputTokens: 50,
      totalTokens: 1750,
      costUSD: 0,
      models: {
        "gpt-5-codex": {
          inputTokens: 1000,
          outputTokens: 200,
          cachedInputTokens: 500,
          reasoningOutputTokens: 50,
          totalTokens: 1750,
          isFallback: false,
        },
      },
    },
    {
      date: "2026-05-26",
      inputTokens: 10,
      outputTokens: 2,
      cachedInputTokens: 0,
      reasoningOutputTokens: 1,
      totalTokens: 13,
      costUSD: 0,
      models: {
        "gpt-5-codex": {
          inputTokens: 10,
          outputTokens: 2,
          cachedInputTokens: 0,
          reasoningOutputTokens: 1,
          totalTokens: 13,
          isFallback: false,
        },
      },
    },
  ],
  totals: {
    inputTokens: 1010,
    outputTokens: 202,
    cachedInputTokens: 500,
    reasoningOutputTokens: 51,
    totalTokens: 1763,
    costUSD: 0,
  },
});

describe("parseCcusageAccounting", () => {
  it("parses the real daily/totals shape and treats subscription costUSD 0 as null", () => {
    const accounting = parseCcusageAccounting(realCcusageOutput, "codex");
    expect(accounting).not.toBeNull();
    expect(accounting?.cli).toBe("codex");
    expect(accounting?.costUsd).toBeNull();
    expect(accounting?.totals).toEqual({
      inputTokens: 1010,
      cachedInputTokens: 500,
      cacheCreationTokens: 0,
      outputTokens: 202,
      reasoningOutputTokens: 51,
      totalTokens: 1763,
    });
    expect(accounting?.perModel).toEqual([
      {
        model: "gpt-5-codex",
        usage: {
          inputTokens: 1010,
          cachedInputTokens: 500,
          cacheCreationTokens: 0,
          outputTokens: 202,
          reasoningOutputTokens: 51,
          totalTokens: 1763,
        },
      },
    ]);
  });

  it("yields zero totals and null cost for an empty ccusage report", () => {
    const accounting = parseCcusageAccounting(
      JSON.stringify({
        daily: [],
        totals: {
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          reasoningOutputTokens: 0,
          totalTokens: 0,
          costUSD: 0,
        },
      }),
      "codex",
    );
    expect(accounting?.costUsd).toBeNull();
    expect(accounting?.totals.totalTokens).toBe(0);
    expect(accounting?.perModel).toEqual([]);
  });

  it("surfaces a positive ccusage costUSD as a real cost figure", () => {
    const accounting = parseCcusageAccounting(
      JSON.stringify({
        daily: [],
        totals: {
          inputTokens: 100,
          outputTokens: 20,
          cachedInputTokens: 0,
          reasoningOutputTokens: 0,
          totalTokens: 120,
          costUSD: 1.234,
        },
      }),
      "codex",
    );
    expect(accounting?.costUsd).toBe(1.234);
  });

  it("returns null for non-JSON / unrecognized shape", () => {
    expect(parseCcusageAccounting("not json", "codex")).toBeNull();
    expect(parseCcusageAccounting(JSON.stringify({ unexpected: true }), "codex")).toBeNull();
  });
});
