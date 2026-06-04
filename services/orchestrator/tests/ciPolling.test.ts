import { readFile } from "node:fs/promises";
import { vcsProviderOver } from "./helpers/vcsProvider.js";
import { describe, expect, it } from "vitest";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import { CiMemoryPool, ScriptedGitHubHttp } from "./helpers/ciPollingPool.js";
import { FetchGitHubHttpClient, parseGitHubPullRequestUrl } from "../src/engine/providers/github.js";
import { computeCiRetryDelayMs, evaluateCiObservation, pollCiForRun } from "../src/engine/workflow/ciPolling.js";

describe("CI polling loop", () => {
  it("parses GitHub PR URLs and classifies pending, passing, and failing checks", () => {
    expect(parseGitHubPullRequestUrl("https://github.com/cat-cave/tanren-fixture-easy/pull/1")).toEqual({
      repo: { owner: "cat-cave", name: "tanren-fixture-easy" },
      pullNumber: 1,
    });
    expect(() => parseGitHubPullRequestUrl("https://example.com/cat-cave/repo/pull/1")).toThrow("unsupported GitHub");

    expect(evaluateCiObservation({ head: { sha: "abc" }, checkRuns: [], statuses: [] })).toMatchObject({
      status: "pending",
      reason: "no_checks",
    });
    expect(
      evaluateCiObservation({
        head: { sha: "abc" },
        checkRuns: [{ name: "build", status: "completed", conclusion: "success" }],
        statuses: [{ context: "legacy", state: "success" }],
      }),
    ).toMatchObject({ status: "passed", reason: "all_checks_passed" });
    expect(
      evaluateCiObservation({
        head: { sha: "abc" },
        checkRuns: [{ name: "build", status: "in_progress" }],
        statuses: [],
      }),
    ).toMatchObject({ status: "pending", reason: "checks_pending" });
    expect(
      evaluateCiObservation({
        head: { sha: "abc" },
        checkRuns: [{ name: "build", status: "completed", conclusion: "timed_out" }],
        statuses: [{ context: "legacy", state: "success" }],
      }),
    ).toMatchObject({ status: "failed", reason: "check_failed" });
  });

  it("gates on required branch-protection checks only (P3-0028)", () => {
    // A required check that hasn't reported yet keeps the run pending even
    // though every OBSERVED check is green.
    expect(
      evaluateCiObservation({
        head: { sha: "abc" },
        checkRuns: [{ name: "build", status: "completed", conclusion: "success" }],
        statuses: [],
        requiredContexts: ["build", "e2e"],
      }),
    ).toMatchObject({ status: "pending", reason: "checks_pending" });

    // An OPTIONAL check failing does not block when it isn't required.
    expect(
      evaluateCiObservation({
        head: { sha: "abc" },
        checkRuns: [
          { name: "build", status: "completed", conclusion: "success" },
          { name: "lint-optional", status: "completed", conclusion: "failure" },
        ],
        statuses: [],
        requiredContexts: ["build"],
      }),
    ).toMatchObject({ status: "passed", reason: "all_checks_passed" });

    // A REQUIRED check failing fails the run.
    expect(
      evaluateCiObservation({
        head: { sha: "abc" },
        checkRuns: [{ name: "build", status: "completed", conclusion: "failure" }],
        statuses: [],
        requiredContexts: ["build"],
      }),
    ).toMatchObject({ status: "failed", reason: "check_failed" });

    // All required contexts present + green → passed.
    expect(
      evaluateCiObservation({
        head: { sha: "abc" },
        checkRuns: [
          { name: "build", status: "completed", conclusion: "success" },
          { name: "e2e", status: "completed", conclusion: "success" },
        ],
        statuses: [],
        requiredContexts: ["build", "e2e"],
      }),
    ).toMatchObject({ status: "passed", reason: "all_checks_passed" });
  });

  it("computes bounded retry backoff for pending CI observations", () => {
    expect(computeCiRetryDelayMs(1)).toBe(5_000);
    expect(computeCiRetryDelayMs(2)).toBe(10_000);
    expect(computeCiRetryDelayMs(4)).toBe(40_000);
    expect(computeCiRetryDelayMs(99)).toBe(60_000);
  });

  it("persists pending CI state without leaking GitHub tokens", async () => {
    const pool = new CiMemoryPool();
    const events = new FakeEventStore();
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: "credential/github/dev", value: "ghp_secretToken" });
    const http = new ScriptedGitHubHttp([
      { status: 200, body: { head: { sha: "abc123", ref: "tanren/run_1" } } },
      { status: 200, body: { check_runs: [] } },
      { status: 200, body: { statuses: [] } },
    ]);

    const result = await pollCiForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets,
      vcsProvider: vcsProviderOver(http),
      runId: "run_1",
    });

    expect(result).toMatchObject({
      runId: "run_1",
      status: "pending",
      reason: "no_checks",
      headSha: "abc123",
      nextPollAfterMs: 5_000,
      summary: { checkRuns: 0, statuses: 0, failing: 0, pending: 0 },
    });
    expect(pool.tasks[0]).toMatchObject({
      run_id: "run_1",
      kind: "ci",
      status: "running",
      outcome: "pending",
      attempt: 1,
    });
    expect(events.events.map((event) => event.eventType)).toEqual(["task.started", "ci.started"]);
    expect(JSON.stringify(events.events)).not.toContain("ghp_secretToken");
    expect(JSON.stringify(http.requests)).not.toContain("ghp_secretToken");
  });

  it("persists passing and failing CI outcomes as inspectable task state", async () => {
    const passPool = new CiMemoryPool();
    const passEvents = new FakeEventStore();
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: "credential/github/dev", value: "ghp_secretToken" });

    await pollCiForRun({
      pool: passPool.asPgPool(),
      eventStore: passEvents,
      secrets,
      vcsProvider: vcsProviderOver(
        new ScriptedGitHubHttp([
          { status: 200, body: { head: { sha: "pass123" } } },
          {
            status: 200,
            body: { check_runs: [{ name: "build", status: "completed", conclusion: "success" }] },
          },
          { status: 200, body: { statuses: [{ context: "legacy", state: "success" }] } },
        ]),
      ),
      runId: "run_1",
    });

    expect(passPool.tasks[0]).toMatchObject({ kind: "ci", status: "done", outcome: "ok" });
    expect(passEvents.events.map((event) => event.eventType)).toEqual(["task.started", "ci.passed", "task.completed"]);

    const failPool = new CiMemoryPool();
    const failEvents = new FakeEventStore();
    await pollCiForRun({
      pool: failPool.asPgPool(),
      eventStore: failEvents,
      secrets,
      vcsProvider: vcsProviderOver(
        new ScriptedGitHubHttp([
          { status: 200, body: { head: { sha: "fail123" } } },
          {
            status: 200,
            body: { check_runs: [{ name: "test", status: "completed", conclusion: "failure" }] },
          },
          { status: 200, body: { statuses: [] } },
        ]),
      ),
      runId: "run_1",
    });

    expect(failPool.tasks[0]).toMatchObject({
      kind: "ci",
      status: "failed",
      outcome: "failed",
      failure_kind: "ci_failed",
    });
    expect(failEvents.events.map((event) => event.eventType)).toEqual(["task.started", "ci.failed", "task.failed"]);
  });

  // The `/runs/:runId/ci/poll` debug API route is GONE (no-Actions delivery model —
  // the native gate is the merge authority, so there is no forge CI to poll over an
  // API). `pollCiForRun` itself is still unit-covered above + below until PR-3 prunes it.
});

const liveGithubTokenFile = process.env.TANREN_GITHUB_TOKEN_FILE;

describe("live CI polling fixture", () => {
  it("observes the fixture PR head when TANREN_GITHUB_TOKEN_FILE is set", async () => {
    if (liveGithubTokenFile === undefined) {
      return;
    }
    expect.hasAssertions();
    const pool = new CiMemoryPool();
    const secrets = new FakeSecretStore();
    await secrets.put({
      ref: "credential/github/dev",
      value: await readFile(liveGithubTokenFile, "utf8"),
    });

    const result = await pollCiForRun({
      pool: pool.asPgPool(),
      eventStore: new FakeEventStore(),
      secrets,
      vcsProvider: vcsProviderOver(new FetchGitHubHttpClient()),
      runId: "run_1",
    });

    expect(["pending", "passed", "failed"]).toContain(result.status);
  });
});
