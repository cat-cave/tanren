import { describe, expect, it } from "vitest";
import { parseCodexbarUsage, parseCodexbarUsageResult } from "../src/engine/usage/codexbarParser.js";

// The real `codexbar usage --provider codex --source cli --format json` shape:
// an ARRAY (one entry per account/provider), with up to three concurrent
// windows (any may be null).
const realCodexbarOutput = JSON.stringify([
  {
    version: "0.134.0",
    usage: {
      accountEmail: "operator@example.com",
      primary: {
        usedPercent: 0,
        resetsAt: "2026-05-28T08:37:21Z",
        windowMinutes: 300,
        resetDescription: "tomorrow, 3:37 AM",
      },
      secondary: {
        usedPercent: 100,
        resetsAt: "2026-05-30T20:19:33Z",
        windowMinutes: 10080,
        resetDescription: "May 30 at 3:19 PM",
      },
      tertiary: null,
      identity: { accountEmail: "operator@example.com", loginMethod: "pro", providerID: "codex" },
      loginMethod: "pro",
      updatedAt: "2026-05-28T03:41:23Z",
    },
    credits: { events: [], remaining: 0, updatedAt: "2026-05-28T03:41:23Z" },
    source: "codex-cli",
    provider: "codex",
  },
]);

describe("parseCodexbarUsage", () => {
  it("parses the real array shape, dropping the null tertiary slot", () => {
    const usage = parseCodexbarUsage(realCodexbarOutput, "codex");
    expect(usage).not.toBeNull();
    expect(usage?.provider).toBe("codex");
    expect(usage?.source).toBe("codex-cli");
    expect(usage?.accountEmail).toBe("operator@example.com");
    expect(usage?.creditsRemaining).toBe(0);
    expect(usage?.capturedAt).toBe("2026-05-28T03:41:23Z");
    expect(usage?.windows).toEqual([
      {
        slot: "primary",
        usedPercent: 0,
        resetsAt: "2026-05-28T08:37:21Z",
        windowMinutes: 300,
        resetDescription: "tomorrow, 3:37 AM",
      },
      {
        slot: "secondary",
        usedPercent: 100,
        resetsAt: "2026-05-30T20:19:33Z",
        windowMinutes: 10080,
        resetDescription: "May 30 at 3:19 PM",
      },
    ]);
  });

  it("returns null for the `[{error:...}]` envelope (tool ran, no data)", () => {
    expect(parseCodexbarUsage(JSON.stringify([{ error: "no codex session found" }]), "codex")).toBeNull();
  });

  it("returns null for an empty array and for non-JSON", () => {
    expect(parseCodexbarUsage("[]", "codex")).toBeNull();
    expect(parseCodexbarUsage("not json", "codex")).toBeNull();
  });

  it("falls back to identity.accountEmail when usage.accountEmail is absent", () => {
    const output = JSON.stringify([
      {
        provider: "codex",
        source: "codex-cli",
        usage: {
          primary: {
            usedPercent: 12,
            resetsAt: "2026-05-28T08:37:21Z",
            windowMinutes: 300,
            resetDescription: "soon",
          },
          identity: { accountEmail: "fallback@example.com" },
        },
      },
    ]);
    const usage = parseCodexbarUsage(output, "codex");
    expect(usage?.accountEmail).toBe("fallback@example.com");
    expect(usage?.windows).toHaveLength(1);
  });

  it("selects the entry matching the requested provider when several are returned", () => {
    const output = JSON.stringify([
      {
        provider: "claude",
        source: "claude-cli",
        usage: {
          primary: { usedPercent: 50, resetsAt: "x", windowMinutes: 300, resetDescription: "" },
        },
      },
      {
        provider: "codex",
        source: "codex-cli",
        usage: {
          primary: { usedPercent: 7, resetsAt: "y", windowMinutes: 300, resetDescription: "" },
        },
      },
    ]);
    const usage = parseCodexbarUsage(output, "codex");
    expect(usage?.provider).toBe("codex");
    expect(usage?.windows[0]?.usedPercent).toBe(7);
  });
});

describe("parseCodexbarUsageResult (discriminated)", () => {
  it("a real array shape is `{ ok: <usage> }`", () => {
    expect(parseCodexbarUsageResult(realCodexbarOutput, "codex")).toMatchObject({ ok: { provider: "codex" } });
  });

  it("the EMPTY `[]` array and `[{error}]` envelope are LEGITIMATE-empty `{ ok: null }` (quiet)", () => {
    expect(parseCodexbarUsageResult("[]", "codex")).toEqual({ ok: null });
    expect(parseCodexbarUsageResult(JSON.stringify([{ error: "no codex session found" }]), "codex")).toEqual({
      ok: null,
    });
  });

  it("whitespace-only stdout is a quiet `{ ok: null }`", () => {
    expect(parseCodexbarUsageResult("  ", "codex")).toEqual({ ok: null });
  });

  it("MALFORMED non-empty output (non-JSON / non-array) is a LOUD `{ failed }` (NOT no-data)", () => {
    expect(parseCodexbarUsageResult("not json", "codex")).toMatchObject({ failed: { detail: "not json" } });
    // codexbar ALWAYS emits a JSON array; an object is contract drift → loud.
    expect("failed" in parseCodexbarUsageResult(JSON.stringify({ unexpected: true }), "codex")).toBe(true);
  });
});
