import { describe, expect, it } from "vitest";
import {
  DEFAULT_MANAGED_CREDENTIAL_REF,
  DEFAULT_MANAGED_ENDPOINT,
  ManagedProviderConfig,
  ProviderMode,
  defaultManagedProviderConfig,
  resolveHarnessEndpointOverride,
} from "../src/engine/config/index.js";
import { migrateOrgConfig, migrateProjectConfig } from "../src/engine/config/index.js";

// SaaS Tier-B #5: the BYOK-vs-managed config + endpoint-resolution primitives.
describe("managed provider config", () => {
  it("defaults to the platform OpenRouter ref + OpenAI-compatible endpoint", () => {
    const managed = defaultManagedProviderConfig();
    expect(managed.credentialRef).toBe(DEFAULT_MANAGED_CREDENTIAL_REF);
    expect(managed.credentialRef).toBe("credential/openrouter/platform/default");
    expect(managed.endpoint).toBe(DEFAULT_MANAGED_ENDPOINT);
    expect(managed.endpoint).toBe("https://openrouter.ai/api/v1");
  });

  it("is strict — rejects unknown keys (no silent JSONB drift)", () => {
    expect(() => ManagedProviderConfig.parse({ credentialRef: "x", endpoint: "y", extra: 1 })).toThrow(/.+/u);
  });

  it("only allows byok | managed for ProviderMode", () => {
    expect(ProviderMode.parse("byok")).toBe("byok");
    expect(ProviderMode.parse("managed")).toBe("managed");
    expect(() => ProviderMode.parse("hosted")).toThrow(/.+/u);
  });

  describe("resolveHarnessEndpointOverride", () => {
    it("returns no override for byok (behavior-preserving)", () => {
      expect(resolveHarnessEndpointOverride("byok")).toBeUndefined();
      expect(resolveHarnessEndpointOverride("byok", defaultManagedProviderConfig())).toBeUndefined();
    });

    it("returns the managed endpoint for managed mode", () => {
      expect(resolveHarnessEndpointOverride("managed")).toEqual({ baseUrl: "https://openrouter.ai/api/v1" });
    });

    it("honors a managed override endpoint", () => {
      const managed = ManagedProviderConfig.parse({ endpoint: "https://proxy.internal/v1" });
      expect(resolveHarnessEndpointOverride("managed", managed)).toEqual({ baseUrl: "https://proxy.internal/v1" });
    });
  });
});

// The toggle round-trips through the versioned config JSONB.
describe("providerMode in versioned config", () => {
  it("defaults a bare version:1 org row to byok", () => {
    const org = migrateOrgConfig({ version: 1 });
    expect(org.providerMode).toBe("byok");
  });

  it("round-trips a managed org row (providerMode only — platform creds are deploy config)", () => {
    const raw = { version: 1, providerMode: "managed" };
    const once = migrateOrgConfig(raw);
    expect(once.providerMode).toBe("managed");
    // Re-parsing the parsed config is a fixed point (stable persistence).
    expect(migrateOrgConfig(once)).toEqual(once);
  });

  it("REJECTS a userland managedProvider block — platform creds are deploy config, not org config", () => {
    expect(() =>
      migrateOrgConfig({
        version: 1,
        providerMode: "managed",
        managedProvider: { credentialRef: "credential/openrouter/platform/eu", endpoint: "https://eu/v1" },
      }),
    ).toThrow(/managedProvider/u);
  });

  it("leaves a bare version:1 project row's providerMode absent (inherits org)", () => {
    expect(migrateProjectConfig({ version: 1 }).providerMode).toBeUndefined();
  });

  it("round-trips a project-level managed override", () => {
    const project = migrateProjectConfig({ version: 1, providerMode: "managed" });
    expect(project.providerMode).toBe("managed");
    expect(migrateProjectConfig(project)).toEqual(project);
  });

  it("rejects an unknown providerMode value on a row", () => {
    expect(() => migrateOrgConfig({ version: 1, providerMode: "hosted" })).toThrow(/.+/u);
  });
});
