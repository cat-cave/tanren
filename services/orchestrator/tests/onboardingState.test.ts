import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import type { InterviewCapture } from "../src/engine/forge/interview/types.js";
import { OnboardingStateSigner } from "../src/engine/forge/onboardingState.js";
import type { ActorContextEnv } from "../src/middleware/auth.js";
import { createOnboardingRoutes } from "../src/routes/onboarding/index.js";

const ORG = "org_state_test";
const actor: ActorContext = {
  userId: "user_state_test",
  orgId: ORG,
  projectId: null,
  scopes: ["platform:admin"],
  source: "session",
};

function tamperCapture(token: string): string {
  const [encoded, signature] = token.split(".");
  if (encoded === undefined || signature === undefined) throw new Error("test token was malformed");
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
    capture: ReturnType<typeof InterviewCapture.parse>;
  };
  payload.capture = {
    ...payload.capture,
    identity: { slug: "tampered", pitch: "tampered", repoHint: "tampered" },
  };
  return `${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}.${signature}`;
}

describe("onboarding signed state", () => {
  it("rejects malformed, missing, stale, and cross-org state", async () => {
    let now = 1_000_000;
    const signer = new OnboardingStateSigner(new InMemorySecretStore(), () => now);
    const token = await signer.signInterview({ orgId: ORG, nextRound: 2, capture: {} });

    await expect(signer.verifyInterview(undefined, ORG)).rejects.toMatchObject({ reason: "missing" });
    await expect(signer.verifyInterview("not-a-token", ORG)).rejects.toMatchObject({ reason: "malformed" });
    await expect(signer.verifyInterview(token, "org_other")).rejects.toMatchObject({ reason: "binding" });

    now += 3_600_001;
    await expect(signer.verifyInterview(token, ORG)).rejects.toMatchObject({ reason: "stale" });
  });

  it("rejects a tampered capture before derive invokes any downstream seam", async () => {
    const secrets = new InMemorySecretStore();
    const signer = new OnboardingStateSigner(secrets);
    const valid = await signer.signInterview({ orgId: ORG, nextRound: 1, capture: {} });
    const tampered = tamperCapture(valid);
    let preflightCalls = 0;
    let answererFactoryCalls = 0;

    const app = new Hono<ActorContextEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", actor);
      await next();
    });
    app.route(
      "/orgs",
      createOnboardingRoutes({
        pool: { query: async () => ({ rows: [], rowCount: 0 }) } as never,
        secrets,
        answererFactory: () => {
          answererFactoryCalls += 1;
          throw new Error("answerer must not be reached");
        },
        githubHttp: {} as never,
        preflightDeploy: async () => {
          preflightCalls += 1;
        },
      }),
    );

    const response = await app.request(`/orgs/${ORG}/onboarding/interview/derive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: tampered, owner: "cat-cave" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_onboarding_state", reason: "signature" });
    expect(answererFactoryCalls).toBe(0);
    expect(preflightCalls).toBe(0);
  });
});
