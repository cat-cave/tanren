import { describe, expect, it } from "vitest";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { publishDraftPullRequestForRun } from "../src/engine/workflow/githubDraftPr.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import { ScriptedGitHubHttp } from "./helpers/githubDraftPrFakes.js";
import { ManualPublicationSsh, ManualRouteDurableHeadPool } from "./helpers/githubDraftPrManualLeaseFixtures.js";

const predecessor = "b".repeat(40);
const staleHead = "a".repeat(40);

class AdvancingDurableHeadPool extends ManualRouteDurableHeadPool {
  private durableReadsSeen = 0;

  override async query(sql: string, params: unknown[]) {
    const result = await super.query(sql, params);
    if (sql.includes("event_type = 'github.branch.pushed'") && ++this.durableReadsSeen === 1) {
      this.publishedHead = predecessor;
    }
    return result;
  }
}

describe("manual draft PR stale snapshot binding", () => {
  it("rejects a workspace snapshot older than the durable predecessor", async () => {
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: "credential/github/org/org_fake/dev", value: "ghp_secret" });
    const pool = new ManualRouteDurableHeadPool();
    pool.publishedHead = predecessor;
    const ssh = new ManualPublicationSsh([staleHead], undefined, true);

    await expect(
      publishDraftPullRequestForRun({
        pool: pool.asPgPool(),
        eventStore: new FakeEventStore(),
        secrets,
        githubHttp: new ScriptedGitHubHttp([], []),
        ssh,
        runId: "run_123",
        identitySecretRef: "runner/local/identity",
      }),
    ).rejects.toThrow("verify manual draft PR workspace snapshot ancestry failed");

    expect(pool.durableReads).toHaveLength(2);
    expect(ssh.commands).toHaveLength(2);
    expect(ssh.commands[1]?.command).toContain(`git merge-base --is-ancestor '${predecessor}' '${staleHead}'`);
  });

  it("rejects when another publisher records a predecessor during snapshot resolution", async () => {
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: "credential/github/org/org_fake/dev", value: "ghp_secret" });
    const pool = new AdvancingDurableHeadPool();
    const ssh = new ManualPublicationSsh([staleHead]);

    await expect(
      publishDraftPullRequestForRun({
        pool: pool.asPgPool(),
        eventStore: new FakeEventStore(),
        secrets,
        githubHttp: new ScriptedGitHubHttp([], []),
        ssh,
        runId: "run_123",
        identitySecretRef: "runner/local/identity",
      }),
    ).rejects.toThrow("durable predecessor advanced while resolving workspace snapshot");

    expect(ssh.commands).toHaveLength(1);
  });
});
