// Dashboard boot env contract — fail-closed prod auth + explicit-dev-profile gate.

import { afterEach, describe, expect, it } from "vitest";
import {
  isExplicitDevProfile,
  isProdProfile,
  parseDashboardEnv,
  resolveDevLoginEnabled,
  resolveRequireAuth,
} from "../src/envSchema.js";

const SAVED = {
  NODE_ENV: process.env.NODE_ENV,
  TANREN_ENV: process.env.TANREN_ENV,
  TANREN_REQUIRE_AUTH: process.env.TANREN_REQUIRE_AUTH,
  TANREN_DEV_LOGIN: process.env.TANREN_DEV_LOGIN,
  TANREN_COOKIE_SECURE: process.env.TANREN_COOKIE_SECURE,
  ORCHESTRATOR_URL: process.env.ORCHESTRATOR_URL,
  DASHBOARD_PORT: process.env.DASHBOARD_PORT,
};

function restoreAll(): void {
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

afterEach(() => {
  restoreAll();
});

describe("isProdProfile / isExplicitDevProfile", () => {
  it("treats NODE_ENV=production and TANREN_ENV prod tokens as prod", () => {
    expect(isProdProfile({ NODE_ENV: "production" })).toBe(true);
    expect(isProdProfile({ TANREN_ENV: "prod" })).toBe(true);
    expect(isProdProfile({ TANREN_ENV: "production" })).toBe(true);
    expect(isProdProfile({ TANREN_ENV: "PROD" })).toBe(true);
    expect(isProdProfile({ NODE_ENV: "test" })).toBe(false);
    expect(isProdProfile({})).toBe(false);
  });

  it("requires a positive explicit-dev marker (unset profile is NOT enough)", () => {
    // Unset / blank profile — refuse (cannot enable solely by cookie-secure-off).
    expect(isExplicitDevProfile({})).toBe(false);
    expect(isExplicitDevProfile({ TANREN_COOKIE_SECURE: "0" })).toBe(false);
    // Positive markers.
    expect(isExplicitDevProfile({ NODE_ENV: "test" })).toBe(true);
    expect(isExplicitDevProfile({ NODE_ENV: "development" })).toBe(true);
    expect(isExplicitDevProfile({ TANREN_ENV: "dev" })).toBe(true);
    expect(isExplicitDevProfile({ TANREN_ENV: "development" })).toBe(true);
    // Prod markers win even if a dev token is also present.
    expect(isExplicitDevProfile({ NODE_ENV: "production" })).toBe(false);
    expect(isExplicitDevProfile({ TANREN_ENV: "prod" })).toBe(false);
    expect(isExplicitDevProfile({ NODE_ENV: "test", TANREN_COOKIE_SECURE: "1" })).toBe(false);
  });
});

describe("resolveRequireAuth (fail-closed)", () => {
  it("defaults ON in prod when unset; OFF outside prod when unset", () => {
    expect(resolveRequireAuth(undefined, true)).toBe(true);
    expect(resolveRequireAuth(undefined, false)).toBe(false);
  });

  it("honors explicit 0/1 regardless of profile", () => {
    expect(resolveRequireAuth("1", false)).toBe(true);
    expect(resolveRequireAuth("0", true)).toBe(false);
  });
});

describe("resolveDevLoginEnabled", () => {
  it("requires both the flag and a positive explicit-dev profile marker", () => {
    // Flag alone (unset profile) — refuse.
    expect(resolveDevLoginEnabled({ TANREN_DEV_LOGIN: "1" })).toBe(false);
    // Flag + cookie-secure-off alone — still refuse.
    expect(resolveDevLoginEnabled({ TANREN_DEV_LOGIN: "1", TANREN_COOKIE_SECURE: "0" })).toBe(false);
    // Flag + explicit marker — on.
    expect(resolveDevLoginEnabled({ TANREN_DEV_LOGIN: "1", NODE_ENV: "test" })).toBe(true);
    expect(resolveDevLoginEnabled({ TANREN_DEV_LOGIN: "1", TANREN_ENV: "dev" })).toBe(true);
    // Prod markers refuse.
    expect(resolveDevLoginEnabled({ TANREN_DEV_LOGIN: "1", NODE_ENV: "production" })).toBe(false);
    expect(resolveDevLoginEnabled({ TANREN_DEV_LOGIN: "1", TANREN_ENV: "production" })).toBe(false);
    expect(resolveDevLoginEnabled({ TANREN_DEV_LOGIN: "1", NODE_ENV: "test", TANREN_COOKIE_SECURE: "1" })).toBe(false);
    expect(resolveDevLoginEnabled({ TANREN_COOKIE_SECURE: "0" })).toBe(false);
    expect(resolveDevLoginEnabled({ TANREN_DEV_LOGIN: "0" })).toBe(false);
    expect(resolveDevLoginEnabled({})).toBe(false);
  });
});

describe("parseDashboardEnv", () => {
  it("defaults ORCHESTRATOR_URL and leaves auth open outside prod", () => {
    const env = parseDashboardEnv({
      NODE_ENV: "test",
      // Explicit empty compose passthrough should behave as unset.
      TANREN_REQUIRE_AUTH: "",
      TANREN_DEV_LOGIN: "",
      ORCHESTRATOR_URL: "",
    });
    expect(env.ORCHESTRATOR_URL).toBe("http://localhost:3100");
    expect(env.requireAuth).toBe(false);
    expect(env.devLoginEnabled).toBe(false);
    expect(env.isProdProfile).toBe(false);
    expect(env.DASHBOARD_PORT).toBe(3000);
  });

  it("fail-closes auth and requires ORCHESTRATOR_URL under NODE_ENV=production", () => {
    expect(() =>
      parseDashboardEnv({
        NODE_ENV: "production",
      }),
    ).toThrow(/ORCHESTRATOR_URL/u);

    const env = parseDashboardEnv({
      NODE_ENV: "production",
      ORCHESTRATOR_URL: "http://orchestrator:3100",
    });
    expect(env.requireAuth).toBe(true);
    expect(env.devLoginEnabled).toBe(false);
    expect(env.ORCHESTRATOR_URL).toBe("http://orchestrator:3100");
  });

  it("fail-closes under TANREN_ENV=prod even without NODE_ENV", () => {
    const env = parseDashboardEnv({
      TANREN_ENV: "prod",
      ORCHESTRATOR_URL: "https://orch.example",
      TANREN_DEV_LOGIN: "1",
    });
    expect(env.isProdProfile).toBe(true);
    expect(env.requireAuth).toBe(true);
    expect(env.devLoginEnabled).toBe(false);
  });

  it("allows explicit TANREN_REQUIRE_AUTH=0 in prod (e2e opt-out)", () => {
    const env = parseDashboardEnv({
      NODE_ENV: "production",
      ORCHESTRATOR_URL: "http://orchestrator:3100",
      TANREN_REQUIRE_AUTH: "0",
    });
    expect(env.requireAuth).toBe(false);
  });

  it("enables dev-login only with flag + non-prod profile", () => {
    const env = parseDashboardEnv({
      NODE_ENV: "development",
      TANREN_DEV_LOGIN: "1",
      TANREN_REQUIRE_AUTH: "1",
    });
    expect(env.devLoginEnabled).toBe(true);
    expect(env.requireAuth).toBe(true);
  });

  it("FAILS LOUD on malformed bool / URL / port", () => {
    expect(() => parseDashboardEnv({ TANREN_REQUIRE_AUTH: "true" })).toThrow(/Invalid dashboard environment/u);
    expect(() => parseDashboardEnv({ ORCHESTRATOR_URL: "not-a-url" })).toThrow(/Invalid dashboard environment/u);
    expect(() => parseDashboardEnv({ DASHBOARD_PORT: "abc" })).toThrow(/Invalid dashboard environment/u);
  });
});
