// Boot-time env schema (the fail-closed env contract). The schema is fed an
// explicit source object so these assertions never mutate the real process.env.
import { describe, expect, it } from "vitest";
import { parseOrchestratorEnv } from "../src/envSchema.js";

// A minimal well-formed env: every field optional/defaulted, so an EMPTY env
// parses cleanly (the in-process dev path). A fully-populated good env exercises
// the coercions + URL/enum validators on the present-value path.
const GOOD_ENV = {
  ORCHESTRATOR_PORT: "3100",
  VAULT_ADDR: "http://vault:8200",
  TANREN_RUNNER_IDENTITY_SECRET_REF: "runner/local-docker/identity",
  TANREN_GITHUB_OAUTH_CLIENT_ID: "client-id",
  TANREN_GITHUB_OAUTH_CLIENT_SECRET: "client-secret",
  TANREN_PUBLIC_BASE_URL: "https://tanren.example.com",
  TANREN_DEV_LOGIN: "1",
  TANREN_COOKIE_SECURE: "0",
  TANREN_INTERNAL_MTLS_PORT: "3110",
  TANREN_INTERNAL_TLS_CERT: "/etc/tanren/mtls/server.crt",
  TANREN_INTERNAL_TLS_KEY: "/etc/tanren/mtls/server.key",
  TANREN_INTERNAL_TLS_CA: "/etc/tanren/mtls/ca.crt",
  TANREN_GITHUB_APP_INSTALL_URL: "https://github.com/apps/tanren/installations/new",
} satisfies NodeJS.ProcessEnv;

describe("orchestrator envSchema (fail-closed at boot)", () => {
  it("accepts a fully-populated good env and coerces numbers", () => {
    const env = parseOrchestratorEnv(GOOD_ENV);
    expect(env.ORCHESTRATOR_PORT).toBe(3100);
    expect(env.TANREN_INTERNAL_MTLS_PORT).toBe(3110);
    expect(env.VAULT_ADDR).toBe("http://vault:8200");
    expect(env.TANREN_PUBLIC_BASE_URL).toBe("https://tanren.example.com");
    expect(env.TANREN_DEV_LOGIN).toBe("1");
    expect(env.TANREN_GITHUB_APP_INSTALL_URL).toBe("https://github.com/apps/tanren/installations/new");
  });

  it("accepts an empty env via defaults (the in-process dev path)", () => {
    const env = parseOrchestratorEnv({});
    expect(env.ORCHESTRATOR_PORT).toBe(3100);
    expect(env.TANREN_INTERNAL_MTLS_PORT).toBe(3110);
    expect(env.VAULT_ADDR).toBe("http://localhost:8200");
    expect(env.TANREN_RUNNER_IDENTITY_SECRET_REF).toBe("runner/local-docker/identity");
    expect(env.TANREN_PUBLIC_BASE_URL).toBeUndefined();
  });

  // One bad-value per field shape: every malformed present value FAILS LOUD.
  it("FAILS LOUD on a non-numeric ORCHESTRATOR_PORT", () => {
    expect(() => parseOrchestratorEnv({ ...GOOD_ENV, ORCHESTRATOR_PORT: "abc" })).toThrow(
      /Invalid orchestrator environment/u,
    );
  });

  it("FAILS LOUD on an out-of-range ORCHESTRATOR_PORT (> 65535)", () => {
    expect(() => parseOrchestratorEnv({ ...GOOD_ENV, ORCHESTRATOR_PORT: "70000" })).toThrow(
      /Invalid orchestrator environment/u,
    );
  });

  it("FAILS LOUD on an out-of-range ORCHESTRATOR_PORT (< 1)", () => {
    expect(() => parseOrchestratorEnv({ ...GOOD_ENV, ORCHESTRATOR_PORT: "0" })).toThrow(
      /Invalid orchestrator environment/u,
    );
  });

  it("FAILS LOUD on a non-numeric TANREN_INTERNAL_MTLS_PORT", () => {
    expect(() => parseOrchestratorEnv({ ...GOOD_ENV, TANREN_INTERNAL_MTLS_PORT: "nope" })).toThrow(
      /Invalid orchestrator environment/u,
    );
  });

  it("FAILS LOUD on a non-URL VAULT_ADDR", () => {
    expect(() => parseOrchestratorEnv({ ...GOOD_ENV, VAULT_ADDR: "not-a-url" })).toThrow(
      /Invalid orchestrator environment/u,
    );
  });

  it("FAILS LOUD on a non-URL TANREN_PUBLIC_BASE_URL", () => {
    expect(() => parseOrchestratorEnv({ ...GOOD_ENV, TANREN_PUBLIC_BASE_URL: "tanren.example.com" })).toThrow(
      /Invalid orchestrator environment/u,
    );
  });

  it("FAILS LOUD on a non-URL TANREN_GITHUB_APP_INSTALL_URL", () => {
    expect(() => parseOrchestratorEnv({ ...GOOD_ENV, TANREN_GITHUB_APP_INSTALL_URL: "github/apps" })).toThrow(
      /Invalid orchestrator environment/u,
    );
  });

  it("FAILS LOUD on a bool flag that is neither 0 nor 1 (TANREN_DEV_LOGIN)", () => {
    expect(() => parseOrchestratorEnv({ ...GOOD_ENV, TANREN_DEV_LOGIN: "true" })).toThrow(
      /Invalid orchestrator environment/u,
    );
  });

  it("FAILS LOUD on a bool flag that is neither 0 nor 1 (TANREN_COOKIE_SECURE)", () => {
    expect(() => parseOrchestratorEnv({ ...GOOD_ENV, TANREN_COOKIE_SECURE: "yes" })).toThrow(
      /Invalid orchestrator environment/u,
    );
  });
});
