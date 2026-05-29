import { describe, expect, it } from "vitest";
import {
  buildChannelRegistry,
  type ChannelRegistryDeps
} from "../src/engine/notifications/registry.js";
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
    for (const kind of [
      "github_checks",
      "teams",
      "discord",
      "email",
      "twilio",
      "pagerduty",
      "webhook"
    ] as const) {
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
      webhook: {}
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
});
