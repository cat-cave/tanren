// ds-composer — the onboarding derive maps a design-F2D authoring halt to a TYPED
// 409, not a generic 500. When the `composeDesignSystem` seam throws
// `DesignFragmentAuthoringFailedError` (a missing design surface could not be
// authored at its fixed point), the route mirrors the code-F2
// `FragmentAuthoringFailedError → 409 fragment_authoring_failed` pattern: a
// fail-closed, correctly-typed `409 design_fragment_authoring_failed` an operator
// can act on (inspect `designFragment.authoring.failed`), never an opaque 500.

import { describe, expect, it } from "vitest";
import { DesignFragmentAuthoringFailedError } from "../src/engine/design/system/authoring/index.js";
import { FakeRepoCreateHttp } from "./conformance/fakes/fakeRepoCreateHttp.js";
import { RoutesPool } from "./helpers/routesPool.js";
import {
  apexCapture,
  appWithGreenfieldRoutes as appWithRoutes,
  preparedDeploy,
  seedGithubAppOrg,
  signedInterviewState,
} from "./helpers/greenfieldRoutes.js";

describe("design_fragment_authoring_failed 409 — typed arm (not a generic 500)", () => {
  it("maps a DesignFragmentAuthoringFailedError from the compose seam to a 409 with its ids + reasons", async () => {
    const pool = new RoutesPool();
    seedGithubAppOrg(pool);
    pool.seedMembership("org_acme", "user_alice", "admin");
    const failedIds = ["surface/components-Components"];
    const failureReasons = { "surface/components-Components": "adapter rejected: token set unresolvable" };
    const { app, onboardingStateSecrets } = appWithRoutes(pool, new FakeRepoCreateHttp(), {
      async preflightDeploy() {},
      async prepareDeploy() {
        return preparedDeploy();
      },
      // Inject a compose seam that simulates an F2D fixed-point halt: it throws the
      // typed error the real producer throws when a missing design fragment cannot be
      // authored. The derive reaches this seam AFTER the graph/design-contract step.
      composeDesignSystem: () => async () => {
        throw new DesignFragmentAuthoringFailedError(failedIds, failureReasons);
      },
    });

    const res = await app.request("/orgs/org_acme/onboarding/interview/derive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        state: await signedInterviewState(apexCapture(), onboardingStateSecrets),
        owner: "cat-cave",
        deploy: { providerKind: "deploy.vercel" },
      }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: string;
      capability: string;
      failedIds: string[];
      failureReasons: Record<string, string>;
      message: string;
    };
    expect(body.error).toBe("design_fragment_authoring_failed");
    expect(body.capability).toBe("design_fragments");
    expect(body.failedIds).toEqual(failedIds);
    expect(body.failureReasons).toEqual(failureReasons);
    expect(body.message).toContain("design fragment authoring failed");
  });
});
