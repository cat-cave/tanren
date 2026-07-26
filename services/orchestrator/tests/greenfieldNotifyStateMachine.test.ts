import { describe, expect, it } from "vitest";
import { FakeRepoCreateHttp } from "./conformance/fakes/fakeRepoCreateHttp.js";
import { RoutesPool } from "./helpers/routesPool.js";
import { appWithGreenfieldRoutes, preparedDeploy, seedGithubAppOrg } from "./helpers/greenfieldRoutes.js";

const headers = { "content-type": "application/json" };
const body = (notify: Record<string, unknown>) =>
  JSON.stringify({
    name: "notify-state-machine",
    owner: "cat-cave",
    greenfield: true,
    deploy: { providerKind: "deploy.vercel", connectionId: "connection_1", grantId: "grant_1" },
    notify,
  });

function seed(): RoutesPool {
  const pool = new RoutesPool();
  seedGithubAppOrg(pool);
  pool.seedMembership("org_acme", "user_alice", "admin");
  return pool;
}

describe("greenfield notify preparation state machine", () => {
  it("runs literal Slack notify preparation after deploy through the direct greenfield state machine", async () => {
    const pool = seed();
    let notifyCalls = 0;
    const { app } = appWithGreenfieldRoutes(pool, new FakeRepoCreateHttp(), {
      async preflightDeploy() {},
      async preflightNotify() {},
      async prepareDeploy() {
        return preparedDeploy();
      },
      async prepareNotify(input) {
        notifyCalls += 1;
        expect(input.notify.providerKind).toBe("slack");
        return {
          outcome: {
            status: "provisioned",
            capability: "notify",
            providerKind: "slack",
            action: "provision",
            mode: "greenfield",
            authority: {
              connectionId: "slack_connection",
              grantId: "slack_grant",
              providerPrincipalId: "workspace",
              authGeneration: 1,
              grantGeneration: 1,
            },
            secretRefNames: ["secret://slack/bot/g/1"],
            surfaces: { notificationTargetId: "target_1", projectConfigKeys: ["slackChannelId"] },
          },
          projectConfig: { slackChannelId: "C_NOTIFY" },
        };
      },
    });
    const response = await app.request("/orgs/org_acme/projects/greenfield", {
      method: "POST",
      headers,
      body: body({ providerKind: "slack", connectionId: "slack_connection", grantId: "slack_grant" }),
    });
    expect(response.status).toBe(201);
    expect(notifyCalls).toBe(1);
    expect([...pool.projects.values()][0]?.config).toMatchObject({ slackChannelId: "C_NOTIFY" });
  });

  it("rejects a deploy provider in notify before state-machine provider preparation", async () => {
    const pool = seed();
    let providerCalls = 0;
    const { app } = appWithGreenfieldRoutes(pool, new FakeRepoCreateHttp(), {
      async prepareNotify() {
        providerCalls += 1;
        throw new Error("must not prepare an invalid notify provider");
      },
    });
    const response = await app.request("/orgs/org_acme/projects/greenfield", {
      method: "POST",
      headers,
      body: body({ providerKind: "deploy.vercel", connectionId: "x", grantId: "y" }),
    });
    expect(response.status).toBe(400);
    expect(providerCalls).toBe(0);
    expect(pool.projects.size).toBe(0);
  });

  it("rejects unlinked Slack before repo, deploy, or notify selection effects", async () => {
    const pool = seed();
    const githubHttp = new FakeRepoCreateHttp();
    const query = pool.query.bind(pool);
    let notifySelectionWrites = 0;
    pool.query = async (sql, params) => {
      if (sql.includes("INSERT INTO project_integration_grant_selections")) notifySelectionWrites += 1;
      return query(sql, params);
    };
    let deployPreparations = 0;
    let notifyProviderCalls = 0;
    const { app } = appWithGreenfieldRoutes(pool, githubHttp, {
      async preflightDeploy() {},
      async prepareDeploy() {
        deployPreparations += 1;
        return preparedDeploy();
      },
      async prepareNotify() {
        notifyProviderCalls += 1;
        throw new Error("unlinked Slack must not reach notify preparation");
      },
    });
    const response = await app.request("/orgs/org_acme/projects/greenfield", {
      method: "POST",
      headers,
      body: body({ providerKind: "slack", connectionId: "slack_connection", grantId: "slack_grant" }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "notify_not_linked",
      status: "not_linked",
      providerKind: "slack",
    });
    expect(githubHttp.createdRepositories).toEqual([]);
    expect(deployPreparations).toBe(0);
    expect(notifyProviderCalls).toBe(0);
    expect(notifySelectionWrites).toBe(0);
    expect(pool.projects.size).toBe(0);
  });
});
