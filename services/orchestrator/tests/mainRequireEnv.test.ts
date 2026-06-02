// The orchestrator's VAULT_TOKEN is REQUIRED — the `?? "dev-root-token"` fallback
// was removed (managed-hosting dimension D). `requireEnv` fails hard on an
// unset/blank value, mirroring `required(env, ...)` in secretStoreFactory.ts.
import { afterEach, describe, expect, it } from "vitest";
import { requireEnv } from "../src/main.js";

describe("orchestrator requireEnv (no dev-root-token fallback)", () => {
  const original = process.env["VAULT_TOKEN"];
  afterEach(() => {
    if (original === undefined) {
      delete process.env["VAULT_TOKEN"];
    } else {
      process.env["VAULT_TOKEN"] = original;
    }
  });

  it("throws when VAULT_TOKEN is unset (no fallback)", () => {
    delete process.env["VAULT_TOKEN"];
    expect(() => requireEnv("VAULT_TOKEN")).toThrow(/VAULT_TOKEN is required/u);
  });

  it("throws when VAULT_TOKEN is blank", () => {
    process.env["VAULT_TOKEN"] = "";
    expect(() => requireEnv("VAULT_TOKEN")).toThrow(/VAULT_TOKEN is required/u);
  });

  it("returns the value when VAULT_TOKEN is set, never the old dev-root-token default", () => {
    process.env["VAULT_TOKEN"] = "a-real-token";
    expect(requireEnv("VAULT_TOKEN")).toBe("a-real-token");
    expect(requireEnv("VAULT_TOKEN")).not.toBe("dev-root-token");
  });
});
