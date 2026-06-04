// cost PR-C: per-credential credit/overage USD-rate resolution + the honest
// Claude-overage reachability classifier. REAL SPEND IS A FACT: the rate is
// resolved from CONFIG (project over org) or returns null-and-loud; the Claude
// overage path is an honest NULL gap, never an approximation.
import { describe, expect, it } from "vitest";
import { resolveCreditUsdRate } from "../src/engine/costs/creditRate.js";
import { classifyOverageReachability } from "../src/engine/costs/claudeOverage.js";

describe("resolveCreditUsdRate", () => {
  const codexRef = "credential/codex/org/o1/default";

  it("resolves the PROJECT rate keyed on the credential ref-kind", () => {
    const result = resolveCreditUsdRate({
      authRef: codexRef,
      projectRates: { "credential/codex": 0.04 },
    });
    expect(result.usdPerCredit).toBe(0.04);
    expect(result.source).toBe("project");
    expect(result.refKind).toBe("credential/codex");
  });

  it("falls back to the ORG default rate when the project has none for the kind", () => {
    const result = resolveCreditUsdRate({
      authRef: codexRef,
      projectRates: {},
      orgRates: { "credential/codex": 0.05 },
    });
    expect(result.usdPerCredit).toBe(0.05);
    expect(result.source).toBe("org");
  });

  it("prefers the PROJECT rate over the org default (project-over-org)", () => {
    const result = resolveCreditUsdRate({
      authRef: codexRef,
      projectRates: { "credential/codex": 0.04 },
      orgRates: { "credential/codex": 0.99 },
    });
    expect(result.usdPerCredit).toBe(0.04);
    expect(result.source).toBe("project");
  });

  it("returns NULL-and-loud (no source) when NO rate is configured at either layer", () => {
    const result = resolveCreditUsdRate({
      authRef: codexRef,
      projectRates: {},
      orgRates: {},
    });
    expect(result.usdPerCredit).toBeNull();
    expect(result.source).toBeNull();
    // The kind is still surfaced so the loud-unknown event can name it.
    expect(result.refKind).toBe("credential/codex");
  });

  it("treats a 0 / negative / NaN configured rate as NO rate (never a $0 silent zero)", () => {
    for (const bad of [0, -1, Number.NaN]) {
      const result = resolveCreditUsdRate({
        authRef: codexRef,
        projectRates: { "credential/codex": bad },
      });
      expect(result.usdPerCredit).toBeNull();
    }
  });

  it("an empty/absent authRef resolves to a null rate with an 'unknown' kind", () => {
    const result = resolveCreditUsdRate({ authRef: "", projectRates: { "credential/codex": 0.04 } });
    expect(result.usdPerCredit).toBeNull();
    expect(result.refKind).toBe("unknown");
  });
});

describe("classifyOverageReachability", () => {
  it("the Codex subscription bundle exposes a real credit-balance delta", () => {
    const r = classifyOverageReachability("credential/codex/org/o1/default");
    expect(r.kind).toBe("credits_delta");
    expect(r.provider).toBe("openai");
    expect(r.authoritativeSource).toBeNull();
  });

  it("the Claude CLI subscription bundle is UNOBSERVABLE locally (honest NULL gap)", () => {
    const r = classifyOverageReachability("credential/claude/org/o1/default");
    expect(r.kind).toBe("unobservable_local");
    expect(r.provider).toBe("anthropic");
    expect(r.authoritativeSource).toBe("anthropic-admin-api-cost-report");
  });

  it("a per-token Anthropic API key is NOT a subscription overage concept", () => {
    expect(classifyOverageReachability("credential/anthropic/org/o1/key").kind).toBe("not_subscription");
  });

  it("a self-hosted / absent ref is not_subscription", () => {
    expect(classifyOverageReachability("credential/self-hosted/local").kind).toBe("not_subscription");
    expect(classifyOverageReachability("").kind).toBe("not_subscription");
  });
});
