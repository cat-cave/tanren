// Bounds the provider token-usage JSONL walk: a hostile/buggy deeply-nested
// event must NOT blow the V8 stack, AND when a bound is hit the parse must be
// LOUD (`usage-parse-bounded`) rather than silently dropping usage. A normal,
// shallow, well-formed event must parse identically to before (no signal).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeJsonlObjectEvents,
  findTokenUsageBounded,
  MAX_JSONL_OBJECT_EVENTS,
  MAX_JSONL_OBJECT_LINE_BYTES,
  MAX_USAGE_PARSE_DEPTH,
  MAX_USAGE_PARSE_NODES,
} from "../src/engine/providers/findTokenUsage.js";
import { parseCodexJsonlTelemetry } from "../src/engine/providers/codex.js";
import type { TokenUsage } from "../src/engine/providers/types.js";

// A minimal disjoint decoder that recognizes {input_tokens, output_tokens}.
function decode(record: Record<string, unknown>): TokenUsage | undefined {
  const input = record["input_tokens"];
  const output = record["output_tokens"];
  if (typeof input !== "number" || typeof output !== "number") return undefined;
  return {
    inputTokens: input,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: output,
    reasoningOutputTokens: 0,
    totalTokens: input + output,
  };
}

// Build an object nested `depth` levels deep, with the usage record at the bottom.
function deeplyNested(depth: number, leaf: Record<string, unknown>): Record<string, unknown> {
  let node: Record<string, unknown> = leaf;
  for (let i = 0; i < depth; i += 1) {
    node = { child: node };
  }
  return node;
}

describe("findTokenUsageBounded", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("parses a normal shallow event identically, with NO loud signal", () => {
    const event = { type: "usage", usage: { input_tokens: 7, output_tokens: 4 } };
    const usage = findTokenUsageBounded("test", event, decode);
    expect(usage).toEqual({
      inputTokens: 7,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 4,
      reasoningOutputTokens: 0,
      totalTokens: 11,
    });
    // Normal case is quiet: the bound was never hit.
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("does NOT blow the stack on a pathologically deep event (returns + loud)", () => {
    // Far deeper than any real provider event, and deeper than a naive unbounded
    // recursion could survive. Usage is buried BELOW the depth cap, so it is not
    // found — and that MUST be loud, never a silent zero.
    const hostile = deeplyNested(MAX_USAGE_PARSE_DEPTH + 5_000, { input_tokens: 1, output_tokens: 1 });
    let usage: TokenUsage | undefined;
    expect(() => {
      usage = findTokenUsageBounded("test", hostile, decode);
    }).not.toThrow();
    expect(usage).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("usage-parse-bounded");
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("max-depth");
  });

  it("emits a loud max-nodes signal when the node budget is exhausted", () => {
    // A very wide object (many sibling keys, all leaves) with no usage anywhere.
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < MAX_USAGE_PARSE_NODES + 1_000; i += 1) {
      wide[`k${i}`] = { v: i };
    }
    let usage: TokenUsage | undefined;
    expect(() => {
      usage = findTokenUsageBounded("test", wide, decode);
    }).not.toThrow();
    expect(usage).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("max-nodes");
  });

  it("finds usage that sits within the bound and stays quiet", () => {
    const ok = deeplyNested(10, { input_tokens: 3, output_tokens: 2 });
    const usage = findTokenUsageBounded("test", ok, decode);
    expect(usage?.inputTokens).toBe(3);
    expect(usage?.outputTokens).toBe(2);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("fails closed with typed records while retaining valid events on both sides", () => {
    const decoded = decodeJsonlObjectEvents(
      '\n{"usage":{"input_tokens":2}}\r\nnot-json\n[]\n42\n{"usage":{"input_tokens":7}}\n',
    );
    expect(decoded.ok).toBe(false);
    if (decoded.ok) throw new Error("expected decode failure");
    expect(decoded.failure).toEqual({
      kind: "jsonl_object_decode_failed",
      failures: [
        { lineNumber: 3, reason: "invalid_json" },
        { lineNumber: 4, reason: "non_object" },
        { lineNumber: 5, reason: "non_object" },
      ],
    });
    expect(decoded.events).toHaveLength(2);
    expect(decoded.events[1]?.["usage"]).toEqual({ input_tokens: 7 });
  });

  it("accepts empty input and rejects trailing or multiple objects on one line", () => {
    expect(decodeJsonlObjectEvents("\n\r\n  \n")).toEqual({ ok: true, rawEventCount: 0, events: [] });
    for (const input of ['{"a":1}\n{"b":', '{"a":1}{"b":2}\n']) {
      const decoded = decodeJsonlObjectEvents(input);
      expect(decoded.ok).toBe(false);
      if (decoded.ok) throw new Error("expected decode failure");
      expect(decoded.failure.failures.at(-1)?.reason).toBe("invalid_json");
    }
  });

  it("accepts the exact line-byte boundary and rejects one byte over without dropping neighbors", () => {
    const prefix = '{"value":"';
    const suffix = '"}';
    const payloadBytes = MAX_JSONL_OBJECT_LINE_BYTES - Buffer.byteLength(prefix + suffix);
    const boundary = `${prefix}${"a".repeat(payloadBytes)}${suffix}`;
    expect(Buffer.byteLength(boundary)).toBe(MAX_JSONL_OBJECT_LINE_BYTES);
    expect(decodeJsonlObjectEvents(boundary).ok).toBe(true);

    const decoded = decodeJsonlObjectEvents(`{"before":true}\n${boundary}a\n{"after":true}\n`);
    expect(decoded.ok).toBe(false);
    if (decoded.ok) throw new Error("expected decode failure");
    expect(decoded.failure.failures).toEqual([{ lineNumber: 2, reason: "line_too_large" }]);
    expect(decoded.events).toEqual([{ before: true }, { after: true }]);
  });

  it("accepts the event-count boundary and returns one bounded failure beyond it", () => {
    expect(decodeJsonlObjectEvents("{}\n".repeat(MAX_JSONL_OBJECT_EVENTS)).ok).toBe(true);
    const over = decodeJsonlObjectEvents("{}\n".repeat(MAX_JSONL_OBJECT_EVENTS + 2));
    expect(over.ok).toBe(false);
    if (over.ok) throw new Error("expected decode failure");
    expect(over.events).toHaveLength(MAX_JSONL_OBJECT_EVENTS);
    expect(over.rawEventCount).toBe(MAX_JSONL_OBJECT_EVENTS + 2);
    expect(over.failure.failures).toEqual([
      { lineNumber: MAX_JSONL_OBJECT_EVENTS + 1, reason: "event_limit_exceeded" },
    ]);
  });

  it("the real codex parser parses a normal nested usage event identically (no signal)", () => {
    const line = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 20 } });
    const out = parseCodexJsonlTelemetry(`${line}\n`);
    expect(out.tokenUsage).toMatchObject({ inputTokens: 100, outputTokens: 20, totalTokens: 120 });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("the real codex parser is BOUNDED + loud on a hostile deeply-nested line", () => {
    // Past the depth cap (so the walk bounds out) but shallow enough that the test
    // harness's own JSON.stringify/JSON.parse survives building the fixture.
    const hostile = deeplyNested(MAX_USAGE_PARSE_DEPTH + 200, {
      usage: { input_tokens: 5, output_tokens: 5 },
    });
    const line = JSON.stringify(hostile);
    let out: ReturnType<typeof parseCodexJsonlTelemetry> | undefined;
    expect(() => {
      out = parseCodexJsonlTelemetry(`${line}\n`);
    }).not.toThrow();
    // Usage was buried below the depth cap → not found, but LOUD (token-accounting
    // invariant): a bounded parse that found nothing is a visible signal.
    expect(out?.tokenUsage).toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("usage-parse-bounded");
    // The structured logger carries the provider in the `provider` field.
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('"provider":"codex"');
  });
});
