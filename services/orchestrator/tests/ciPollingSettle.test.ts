// Run-loop NO-CHECKS SETTLE tests (the fix for a no-CI repo hanging the CI gate
// forever). A genuinely-zero-checks observation on a repo with NO CI registered is
// PROMOTED pending→passed once the no-checks grace elapses (anchored on the STABLE CI
// task `started_at`). The safety boundary is preserved: `checks_pending` (real CI not
// done) and a failing check are NEVER promoted; the Mergify-present fast path is
// untouched. Driven over the shared CI-polling fakes + a SEEDED task `started_at` + an
// injectable clock, plus pure-function unit tests of `settleNoChecksObservation`.

import { describe, expect, it } from "vitest";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import { CiMemoryPool, ScriptedGitHubHttp } from "./helpers/ciPollingPool.js";
import { vcsProviderOver } from "./helpers/vcsProvider.js";
import type { GitHubHttpResponse } from "../src/engine/providers/github.js";
import { type CiObservation, pollCiForRun, settleNoChecksObservation } from "../src/engine/workflow/ciPolling.js";

const NOW = 1_000_000_000;

function noCiResponses(): GitHubHttpResponse[] {
  return [
    { status: 200, body: { head: { sha: "abc123" } } },
    { status: 200, body: { check_runs: [] } },
    { status: 200, body: { statuses: [] } },
  ];
}

// Seed a pre-existing CI task whose `started_at` is a fixed past instant, so the next
// poll's settle anchor is STABLE (not reset to now).
function seedCiTask(pool: CiMemoryPool, startedAt: Date): void {
  pool.tasks.push({
    task_id: "task_seeded",
    run_id: "run_1",
    kind: "ci",
    title: "Poll pull request CI",
    status: "running",
    outcome: "pending",
    agent_kind: "system",
    cli: "github",
    model: null,
    attempt: 1,
    started_at: startedAt,
  });
}

async function makeSecrets(): Promise<FakeSecretStore> {
  const secrets = new FakeSecretStore();
  await secrets.put({ ref: "credential/github/dev", value: "ghp_secretToken" });
  return secrets;
}

describe("run-loop no-checks settle (no-CI repo hang fix)", () => {
  it("no_checks + elapsed >= settle → ci.passed (reason no_checks_settled)", async () => {
    const pool = new CiMemoryPool();
    const events = new FakeEventStore();
    // The task started 46s ago — past the 45s default grace.
    seedCiTask(pool, new Date(NOW - 46_000));

    const result = await pollCiForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: await makeSecrets(),
      vcsProvider: vcsProviderOver(new ScriptedGitHubHttp(noCiResponses())),
      runId: "run_1",
      now: () => NOW,
    });

    expect(result).toMatchObject({ status: "passed", reason: "no_checks_settled" });
    // The genuinely-zero-checks gate flips green: ci.passed + task.completed fire.
    expect(events.events.map((e) => e.eventType)).toEqual(["ci.passed", "task.completed"]);
    expect(pool.tasks[0]).toMatchObject({ kind: "ci", status: "done", outcome: "ok" });
  });

  it("no_checks + elapsed < settle → still pending (ci.started), not promoted", async () => {
    const pool = new CiMemoryPool();
    const events = new FakeEventStore();
    // The task started 10s ago — well within the 45s grace.
    seedCiTask(pool, new Date(NOW - 10_000));

    const result = await pollCiForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: await makeSecrets(),
      vcsProvider: vcsProviderOver(new ScriptedGitHubHttp(noCiResponses())),
      runId: "run_1",
      now: () => NOW,
    });

    expect(result).toMatchObject({ status: "pending", reason: "no_checks" });
    expect(events.events.map((e) => e.eventType)).toEqual(["ci.started"]);
  });

  it("checks_pending (real CI registered) → pending REGARDLESS of elapsed (never promoted)", async () => {
    const pool = new CiMemoryPool();
    const events = new FakeEventStore();
    // Far past the grace — a registered-but-pending check NEVER settles.
    seedCiTask(pool, new Date(NOW - 10_000_000));

    const result = await pollCiForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: await makeSecrets(),
      vcsProvider: vcsProviderOver(
        new ScriptedGitHubHttp([
          { status: 200, body: { head: { sha: "abc123" } } },
          { status: 200, body: { check_runs: [{ name: "build", status: "in_progress" }] } },
          { status: 200, body: { statuses: [] } },
        ]),
      ),
      runId: "run_1",
      now: () => NOW,
    });

    expect(result).toMatchObject({ status: "pending", reason: "checks_pending" });
    expect(events.events.map((e) => e.eventType)).toEqual(["ci.started"]);
  });

  it("Mergify-present (checkRuns non-empty, all passed) → passes immediately (unaffected)", async () => {
    const pool = new CiMemoryPool();
    const events = new FakeEventStore();
    // Even with a recent task (no grace elapsed), an all-green check passes NOW.
    seedCiTask(pool, new Date(NOW - 1_000));

    const result = await pollCiForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: await makeSecrets(),
      vcsProvider: vcsProviderOver(
        new ScriptedGitHubHttp([
          { status: 200, body: { head: { sha: "abc123" } } },
          { status: 200, body: { check_runs: [{ name: "build", status: "completed", conclusion: "success" }] } },
          { status: 200, body: { statuses: [] } },
        ]),
      ),
      runId: "run_1",
      now: () => NOW,
    });

    // The fast path: all_checks_passed (not the settle reason) — immediate pass.
    expect(result).toMatchObject({ status: "passed", reason: "all_checks_passed" });
  });
});

function obs(reason: CiObservation["reason"], status: CiObservation["status"]): CiObservation {
  return {
    status,
    reason,
    headSha: "abc",
    checkRuns: [],
    statuses: [],
    failingChecks: [],
    pendingChecks: [],
  };
}

describe("settleNoChecksObservation (pure run-loop settle policy)", () => {
  it("promotes no_checks → passed (no_checks_settled) once the grace elapses", () => {
    const settled = settleNoChecksObservation(obs("no_checks", "pending"), 0, 45_000, 45_000);
    expect(settled).toMatchObject({ status: "passed", reason: "no_checks_settled" });
  });

  it("keeps no_checks pending before the grace", () => {
    const held = settleNoChecksObservation(obs("no_checks", "pending"), 0, 45_000, 44_999);
    expect(held).toMatchObject({ status: "pending", reason: "no_checks" });
  });

  it("never promotes checks_pending (real CI registered) regardless of elapsed", () => {
    const held = settleNoChecksObservation(obs("checks_pending", "pending"), 0, 45_000, 10_000_000);
    expect(held).toMatchObject({ status: "pending", reason: "checks_pending" });
  });

  it("never promotes a failing check (a red check always blocks)", () => {
    const failed = settleNoChecksObservation(obs("check_failed", "failed"), 0, 45_000, 10_000_000);
    expect(failed).toMatchObject({ status: "failed", reason: "check_failed" });
  });

  it("leaves an already-passed all_checks_passed untouched", () => {
    const passed = settleNoChecksObservation(obs("all_checks_passed", "passed"), 0, 45_000, 10_000_000);
    expect(passed).toMatchObject({ status: "passed", reason: "all_checks_passed" });
  });
});
