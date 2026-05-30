import { describe, expect, it } from "vitest";
import { buildChannelRegistry, type ChannelRegistryDeps } from "../src/engine/notifications/registry.js";
import { ChannelKind } from "../src/engine/notifications/index.js";

// Registry tests: the six batch channels wire to real (wired:true) adapters
// when their deps key is supplied, and fall back to the StubChannel
// (wired:false) when it is not.

describe("buildChannelRegistry", () => {
  it("always wires ntfy and slack (they degrade safely)", () => {
    const registry = buildChannelRegistry();
    expect(registry.ntfy.wired).toBe(true);
    expect(registry.slack.wired).toBe(true);
  });

  it("falls back to a stub for every dep-gated channel when no deps are given", () => {
    const registry = buildChannelRegistry();
    for (const kind of ["github_checks", "teams", "discord", "email", "twilio", "pagerduty", "webhook"] as const) {
      expect(registry[kind].kind).toBe(kind);
      expect(registry[kind].wired).toBe(false);
    }
  });

  it("wires each batch channel when its deps key is supplied", () => {
    const deps: ChannelRegistryDeps = {
      teams: {},
      discord: {},
      email: {},
      twilio: {},
      pagerduty: {},
      webhook: {},
    };
    const registry = buildChannelRegistry(deps);
    for (const kind of ["teams", "discord", "email", "twilio", "pagerduty", "webhook"] as const) {
      expect(registry[kind].kind).toBe(kind);
      expect(registry[kind].wired).toBe(true);
    }
  });

  it("builds an entry for every ChannelKind", () => {
    const registry = buildChannelRegistry();
    for (const kind of ChannelKind.options) {
      expect(registry[kind]).toBeDefined();
      expect(registry[kind].kind).toBe(kind);
    }
  });

  it("wires github_checks only when its github deps key is supplied", () => {
    const fakeSecrets = {
      async get() {},
    };
    const wired = buildChannelRegistry({ github: { secrets: fakeSecrets } });
    expect(wired.github_checks.wired).toBe(true);
    expect(wired.github_checks.kind).toBe("github_checks");
    // Supplying an unrelated dep must NOT wire github_checks.
    const unrelated = buildChannelRegistry({ teams: {} });
    expect(unrelated.github_checks.wired).toBe(false);
  });

  it("wires ntfy and slack to their real adapters (kind preserved) even with explicit deps", () => {
    const registry = buildChannelRegistry({ ntfy: { baseUrl: "http://x" }, slack: {} });
    expect(registry.ntfy.kind).toBe("ntfy");
    expect(registry.ntfy.wired).toBe(true);
    expect(registry.slack.kind).toBe("slack");
    expect(registry.slack.wired).toBe(true);
  });

  it("keeps each unwired batch channel reporting its own kind via the stub", () => {
    const registry = buildChannelRegistry({ teams: {} });
    // teams is wired; the others fall to stubs but still carry their kind.
    for (const kind of ["discord", "email", "twilio", "pagerduty", "webhook"] as const) {
      expect(registry[kind].kind).toBe(kind);
      expect(registry[kind].wired).toBe(false);
    }
  });
});
