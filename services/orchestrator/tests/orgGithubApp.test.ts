import { describe, expect, it } from "vitest";
import type { OrgGithubAppInstallation } from "../src/engine/config/orgConfig.js";
import {
  loadOrgGithubAppInstallation,
  persistOrgGithubAppInstallation,
} from "../src/engine/credentials/orgGithubApp.js";
import { RoutesPool } from "./helpers/routesPool.js";

const installation: OrgGithubAppInstallation = {
  installationId: "9001",
  appId: "1",
  credentialRef: "credential/github_app/org/org_acme/default",
  installedAt: "2026-05-01T00:00:00.000Z",
};

describe("orgGithubApp installation round-trip", () => {
  it("returns undefined when the org row does not exist", async () => {
    const pool = new RoutesPool();
    expect(await loadOrgGithubAppInstallation(pool.asPgPool(), "org_missing")).toBeUndefined();
  });

  it("returns undefined when the org config carries no github_app block", async () => {
    const pool = new RoutesPool();
    pool.seedOrg({ id: "org_acme", config: { version: 1 } });
    expect(await loadOrgGithubAppInstallation(pool.asPgPool(), "org_acme")).toBeUndefined();
  });

  it("persists then loads the exact installation block", async () => {
    const pool = new RoutesPool();
    pool.seedOrg({ id: "org_acme", config: { version: 1 } });
    const wrote = await persistOrgGithubAppInstallation(pool.asPgPool(), "org_acme", installation);
    expect(wrote).toBe(true);
    const loaded = await loadOrgGithubAppInstallation(pool.asPgPool(), "org_acme");
    expect(loaded).toEqual(installation);
  });

  it("preserves other config keys when writing the github_app block", async () => {
    const pool = new RoutesPool();
    pool.seedOrg({
      id: "org_acme",
      config: { version: 1, defaultCredentials: { github_token: "credential/github/x" } },
    });
    await persistOrgGithubAppInstallation(pool.asPgPool(), "org_acme", installation);
    const stored = pool.orgs.get("org_acme")?.config as { defaultCredentials?: unknown; github_app?: unknown };
    expect(stored.defaultCredentials).toEqual({ github_token: "credential/github/x" });
    expect(stored.github_app).toEqual(installation);
  });

  it("returns false when persisting to a missing org row (no write happens)", async () => {
    const pool = new RoutesPool();
    const wrote = await persistOrgGithubAppInstallation(pool.asPgPool(), "org_ghost", installation);
    expect(wrote).toBe(false);
    expect(pool.orgs.get("org_ghost")).toBeUndefined();
  });
});
