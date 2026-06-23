// Task #21B — the derive HTTP boundary maps a child-run STALL to a distinct 504
// (template_build_stalled), NOT the generic 409 template_required, so the operator
// sees the stalled child project id + the sign-of-life signature directly. The
// stall is the INNER `cause` of a `TemplateBuildFailedError`, itself the INNER
// `cause` of the `TemplateRequiredError` that selection raises on a failed just-
// in-time creation (templateSelection.createForNoMatchOrHalt). The route handler
// walks the standard `Error.cause` chain to recognize it.

import { describe, expect, it } from "vitest";
import { FakeRepoCreateHttp } from "./conformance/fakes/fakeRepoCreateHttp.js";
import { RoutesPool } from "./helpers/routesPool.js";
import {
  apexCapture,
  appWithGreenfieldRoutes as appWithRoutes,
  preparedDeploy,
  seedGithubAppOrg,
} from "./helpers/greenfieldRoutes.js";
import { ChildRunStalledError } from "../src/engine/templates/index.js";
import { TemplateBuildFailedError } from "../src/engine/templates/creation/buildDriver.js";

describe("onboarding derive route — task #21B child-run stall surfaces as 504 template_build_stalled", () => {
  it("returns 504 template_build_stalled (NOT 409 template_required) when the no-match build halts on a sign-of-life stall", async () => {
    // The just-in-time creation seam THROWS a `TemplateBuildFailedError` whose
    // inner cause is a `ChildRunStalledError` — the apex v49 shape: the child
    // template-build project's event-stream identity held flat across the streak
    // ceiling, the build driver halted LOUD, and `selectTemplate` re-threw it as
    // `TemplateRequiredError(cause: buildFailed)`. The route's 504 branch walks
    // the `cause` chain and surfaces the child project id + signature directly.
    const pool = new RoutesPool();
    seedGithubAppOrg(pool);
    pool.seedMembership("org_acme", "user_alice", "admin");
    const { app, githubHttp } = appWithRoutes(pool, new FakeRepoCreateHttp(), {
      async preflightDeploy() {},
      async prepareDeploy() {
        return preparedDeploy();
      },
      // The just-in-time creation seam raises the stall — the same shape the live
      // build driver throws when its child-run progress probe ceiling fires.
      createTemplateForNoMatch: () => async () => {
        throw new TemplateBuildFailedError(
          "project_tmpl_child",
          "template build STALLED — child project project_tmpl_child emitted no audit-event progress",
          { cause: new ChildRunStalledError("project_tmpl_child", BigInt(42), 10) },
        );
      },
    });

    const res = await app.request("/orgs/org_acme/onboarding/interview/derive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capture: apexCapture(),
        owner: "cat-cave",
        deploy: { providerKind: "deploy.vercel" },
      }),
    });

    expect(res.status).toBe(504);
    const body = (await res.json()) as {
      error: string;
      capability: string;
      stack: string;
      childProjectId: string;
      lastSignatureValue: string;
      nonAdvancingProbes: number;
      message: string;
    };
    expect(body.error).toBe("template_build_stalled");
    expect(body.capability).toBe("template");
    expect(body.stack).toBe("ts/pnpm");
    expect(body.childProjectId).toBe("project_tmpl_child");
    // The signature value round-trips as a string (bigint is not JSON-serializable).
    expect(body.lastSignatureValue).toBe("42");
    expect(body.nonAdvancingProbes).toBe(10);
    expect(body.message).toMatch(/STALLED/u);
    // No project / repo leaked through the fail-closed halt (it preceded creation).
    expect(pool.projects.size).toBe(0);
    expect(githubHttp.createdRepositories).toEqual([]);
  });
});
