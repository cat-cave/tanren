// v66 fix — the derive 409 (`fragment_authoring_failed`) MUST carry the per-
// fragment writer rejection reason on its body so the operator can diagnose F2
// halts without grepping orchestrator logs (the templating-system doctrine
// points operators to `fragment.authoring.failed` events; this fix mirrors that
// payload onto the synchronous response so the cause is read directly off the
// 409 too).

import { describe, expect, it } from "vitest";
import { loadFragmentLibrary } from "../src/engine/templates/index.js";
import { FakeRepoCreateHttp } from "./conformance/fakes/fakeRepoCreateHttp.js";
import { RoutesPool } from "./helpers/routesPool.js";
import {
  apexCapture,
  appWithGreenfieldRoutes as appWithRoutes,
  preparedDeploy,
  seedGithubAppOrg,
} from "./helpers/greenfieldRoutes.js";

describe("fragment_authoring_failed 409 — failureReasons propagation (v66)", () => {
  it("surfaces per-fragment writer-rejection reasons on the 409 body", async () => {
    const pool = new RoutesPool();
    seedGithubAppOrg(pool);
    pool.seedMembership("org_acme", "user_alice", "admin");
    const reasonsByFragment = {
      "runtime-python": "body parse rejected: vfs.write(...) accepts string literals only",
    };
    const { app, githubHttp } = appWithRoutes(pool, new FakeRepoCreateHttp(), {
      async preflightDeploy() {},
      async prepareDeploy() {
        return preparedDeploy();
      },
      // Wire a runFragmentAuthoring seam that simulates an F2 fixed-point halt:
      // it returns failedIds + per-id failureReasons (the exact shape the live
      // runner returns when the writer's body keeps failing validation). The
      // derive throws on failedIds.length > 0 before reading `library`, so the
      // bundled library suffices.
      runFragmentAuthoring: () => async (input) => {
        const failedIds = input.missing.map((m) => m.id);
        return {
          library: loadFragmentLibrary(),
          failedIds,
          failureReasons: Object.fromEntries(
            failedIds.map((id) => [id, reasonsByFragment[id as keyof typeof reasonsByFragment] ?? "unknown rejection"]),
          ),
        };
      },
    });

    const res = await app.request("/orgs/org_acme/onboarding/interview/derive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        // A stack whose open-world tokenization yields runtime-<unknown>, forcing
        // a missing-fragments decision so the wired runFragmentAuthoring fires.
        capture: {
          ...apexCapture(),
          lifecycle: { ...apexCapture().lifecycle, stack: "russian-fanfiction-tools + fly" },
        },
        owner: "cat-cave",
        deploy: { providerKind: "deploy.vercel" },
      }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: string;
      failedIds: string[];
      failureReasons: Record<string, string>;
      message: string;
    };
    expect(body.error).toBe("fragment_authoring_failed");
    expect(body.failedIds.length).toBeGreaterThan(0);
    // The actual rejection string flows F2 → result → error → 409 body.
    for (const id of body.failedIds) {
      expect(body.failureReasons[id]).toBeDefined();
      expect(body.failureReasons[id]?.length ?? 0).toBeGreaterThan(0);
    }
    // The aggregated `message` also embeds the reasons (operator-readable text).
    expect(body.message).toContain("Reasons:");
    // No project / repo created — halt is fail-closed.
    expect(pool.projects.size).toBe(0);
    expect(githubHttp.createdRepositories).toEqual([]);
  });
});
