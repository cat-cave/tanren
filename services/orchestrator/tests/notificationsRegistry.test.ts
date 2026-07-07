import { describe, expect, it } from "vitest";
import {
  buildChannelRegistry,
  ChannelNotConfiguredError,
  wiredChannelKinds,
  type ChannelRegistryDeps,
} from "../src/engine/notifications/registry.js";
import { ChannelKind } from "../src/engine/notifications/index.js";
import type { SecretStore } from "../src/engine/contracts/secretStore.js";

// Registry tests: every credential-resolving channel wires to a real
// (wired:true) adapter when its deps key — carrying the secret store it needs —
// is supplied, and falls back to the StubChannel (wired:false) when it is not.
// Only ntfy is always wired (it degrades safely via an env-default base URL).

const fakeSecrets: SecretStore = {
  async get() {},
};

describe("buildChannelRegistry", () => {
  it("always wires ntfy (it degrades safely) but stubs slack without its deps", () => {
    const registry = buildChannelRegistry();
    expect(registry.ntfy.wired).toBe(true);
    expect(registry.slack.wired).toBe(false);
  });

  it("falls back to a stub for every dep-gated channel when no deps are given", () => {
    const registry = buildChannelRegistry();
    for (const kind of [
      "slack",
      "github_checks",
      "teams",
      "discord",
      "email",
      "twilio",
      "pagerduty",
      "webhook",
    ] as const) {
      expect(registry[kind].kind).toBe(kind);
      expect(registry[kind].wired).toBe(false);
    }
  });

  it("wires each batch channel when its deps key is supplied", () => {
    const deps: ChannelRegistryDeps = {
      slack: { secrets: fakeSecrets },
      teams: { secrets: fakeSecrets },
      discord: { secrets: fakeSecrets },
      email: {},
      twilio: {},
      pagerduty: { secrets: fakeSecrets },
      webhook: { secrets: fakeSecrets },
    };
    const registry = buildChannelRegistry(deps);
    for (const kind of ["slack", "teams", "discord", "email", "twilio", "pagerduty", "webhook"] as const) {
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
    const wired = buildChannelRegistry({ github: { secrets: fakeSecrets } });
    expect(wired.github_checks.wired).toBe(true);
    expect(wired.github_checks.kind).toBe("github_checks");
    // Supplying an unrelated dep must NOT wire github_checks.
    const unrelated = buildChannelRegistry({ teams: { secrets: fakeSecrets } });
    expect(unrelated.github_checks.wired).toBe(false);
  });

  it("wires ntfy and slack to their real adapters (kind preserved) when deps are supplied", () => {
    const registry = buildChannelRegistry({ ntfy: { baseUrl: "http://x" }, slack: { secrets: fakeSecrets } });
    expect(registry.ntfy.kind).toBe("ntfy");
    expect(registry.ntfy.wired).toBe(true);
    expect(registry.slack.kind).toBe("slack");
    expect(registry.slack.wired).toBe(true);
  });

  it("keeps each unwired batch channel reporting its own kind via the stub", () => {
    const registry = buildChannelRegistry({ teams: { secrets: fakeSecrets } });
    // teams is wired; the others fall to stubs but still carry their kind.
    for (const kind of ["slack", "discord", "email", "twilio", "pagerduty", "webhook"] as const) {
      expect(registry[kind].kind).toBe(kind);
      expect(registry[kind].wired).toBe(false);
    }
  });

  // Codex H3 Surface 6 #17: the boot-time missing-dep guard. When any REQUIRED
  // channel is missing its dep, `buildChannelRegistry` throws a typed
  // `ChannelNotConfiguredError` at boot rather than silently substituting a
  // StubChannel whose no-op publish would drop the fail-severity escalation.
  it("throws ChannelNotConfiguredError when a required channel is missing its dep", () => {
    expect(() => buildChannelRegistry({}, { requiredChannels: new Set<ChannelKind>(["slack"]) })).toThrow(
      ChannelNotConfiguredError,
    );
  });

  it("names the unwired kind on the ChannelNotConfiguredError instance", () => {
    let caught: unknown;
    try {
      buildChannelRegistry({}, { requiredChannels: new Set<ChannelKind>(["teams"]) });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ChannelNotConfiguredError);
    expect((caught as ChannelNotConfiguredError).kind).toBe("teams");
  });

  it("does NOT throw for a NOT-required unwired channel (unrouted absence is fine)", () => {
    // slack is unwired but not in the required set — the legacy stub audit
    // path applies (tests only).
    expect(() => buildChannelRegistry({}, { requiredChannels: new Set<ChannelKind>(["ntfy"]) })).not.toThrow();
  });

  it("succeeds when every required channel is wired", () => {
    const deps: ChannelRegistryDeps = {
      slack: { secrets: fakeSecrets },
      teams: { secrets: fakeSecrets },
    };
    const registry = buildChannelRegistry(deps, {
      requiredChannels: new Set<ChannelKind>(["ntfy", "slack", "teams"]),
    });
    expect(registry.ntfy.wired).toBe(true);
    expect(registry.slack.wired).toBe(true);
    expect(registry.teams.wired).toBe(true);
  });

  // Codex H3 Surface 6 #18: `wiredChannelKinds` reports the current registry's
  // wired set. The route-write endpoint uses it to reject creating a route to
  // a channel whose adapter isn't wired.
  it("wiredChannelKinds returns exactly the kinds whose adapter is wired", () => {
    const registry = buildChannelRegistry({ slack: { secrets: fakeSecrets } });
    const wired = wiredChannelKinds(registry);
    expect(wired.has("ntfy")).toBe(true);
    expect(wired.has("slack")).toBe(true);
    expect(wired.has("teams")).toBe(false);
    expect(wired.has("discord")).toBe(false);
  });
});
