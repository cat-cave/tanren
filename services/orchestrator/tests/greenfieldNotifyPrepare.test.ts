import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { prepareGreenfieldNotify } from "../src/routes/projects/greenfieldDeployPrepare.js";

describe("prepareGreenfieldNotify", () => {
  it("rejects a deploy-only fallback before constructing or invoking a Slack provider", async () => {
    let provisionerBuilds = 0;
    await expect(
      prepareGreenfieldNotify({
        pool: {} as never,
        secrets: new InMemorySecretStore(),
        orgId: "org_1",
        projectId: "project_1",
        actorId: "operator_1",
        projectName: "greenfield-app",
        notify: { providerKind: "deploy.vercel" as never, mode: "greenfield" },
        buildProvisioner: () => {
          provisionerBuilds += 1;
          throw new Error("must not construct a provider for a deploy fallback");
        },
      }),
    ).rejects.toThrow(/requires providerKind 'slack'/u);
    expect(provisionerBuilds).toBe(0);
  });
});
