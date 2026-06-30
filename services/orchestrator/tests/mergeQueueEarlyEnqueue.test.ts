// apex v67/v69 loop-close fix: the EARLY-PATH merge_queue enqueue.
//
// THE BUG (apex v67 = 4 PRs pushed / 0 merge_queue rows; v69 = 2 / 0): the merge_queue
// enqueue lived at the END of the writer chain (`runPublishGateStage` → `pollReview` →
// `applyReviewVerdict("merge")` → `mergeForRun` → `enqueueNative`), but the PR was
// created at the FRONT (`publishCleanedDraftPr` → `publishDraftPullRequest`). Any
// failure mode AFTER PR-open — gate fixed-point halt, review polling halt, transient
// exception in `finalizeWorkflowThrow` — returned from `runPlannerLoopWorkflow` BEFORE
// reaching `mergeForRun`. The walker re-walked the spec, created a NEW run, abandoned
// the live PR on GitHub. The merge_queue stayed empty; the coordinator subscriber had
// nothing to drive; the autonomous loop never closed.
//
// THE FIX: the enqueue moves to immediately after `github.pr.created` is appended. The
// PR's existence is the durable signal it should be tracked. `MergeAuthority.authorizeLand`
// still enforces every land precondition (gate/review/mergeability/etc.) at land time, so
// an early-scheduled entry HOLDS in the queue until those clear — never a premature land.
// `merge.scheduled` is the new observable signal for this early-path enqueue (distinct
// from `merge.queued`, which the late-path `mergeForRun → enqueueNative` still emits
// when the chain DOES reach it — that path becomes idempotent via the existing
// `merge_queue_active_run_unique` partial index).

import { describe, expect, it } from "vitest";
import { RecordingPool, RecordingSsh, ScriptedGitHubHttp } from "./helpers/githubDraftPrFakes.js";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import { publishDraftPullRequest } from "../src/engine/workflow/githubDraftPr.js";
import { mergeQueueEarlyEnqueueSeam } from "../src/engine/workflow/plannerRunSeams.js";
import type { PlannerRunContext, RunPlannerLoopInput } from "../src/engine/workflow/plannerRun.js";
import type { NativeQueueEnqueuer } from "../src/engine/workflow/reviewMerge/index.js";

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};

/** A recording native-queue enqueuer the test asserts against (production: PgMergeQueueModel). */
function recordingEnqueuer(opts: { created?: boolean } = {}): {
  enqueue: NativeQueueEnqueuer;
  calls: Array<{ projectId: string; runId: string; specId: string; prUrl: string; prNumber: number }>;
} {
  const calls: Array<{ projectId: string; runId: string; specId: string; prUrl: string; prNumber: number }> = [];
  return {
    calls,
    enqueue: async (input) => {
      calls.push({ ...input });
      return { created: opts.created ?? true };
    },
  };
}

async function publishWithSeam(input: {
  enqueue?: NativeQueueEnqueuer;
  mergeIntegration?: "native_queue" | "direct_merge" | "external_reviewer" | "not_configured";
}): Promise<{ events: FakeEventStore }> {
  const secrets = new FakeSecretStore();
  await secrets.put({ ref: "credential/github/dev", value: "ghp_test" });
  const http = new ScriptedGitHubHttp([
    { status: 200, body: [] },
    {
      status: 201,
      body: {
        number: 42,
        html_url: "https://github.com/cat-cave/repo/pull/42",
        draft: true,
        base: { ref: "main" },
      },
    },
  ]);
  const ssh = new RecordingSsh();
  const events = new FakeEventStore();
  const pool = new RecordingPool();

  const enqueuer = input.enqueue;
  const context: PlannerRunContext = {
    runId: "run_42",
    specId: "spec_42",
    projectId: "project_42",
    orgId: "org_42",
    repoUrl: "https://github.com/cat-cave/repo.git",
    targetBranch: "main",
    runBranch: "tanren/run_42",
    specTitle: "Add fixture",
    specDescription: "",
    acceptanceCriteria: [],
    runnerImage: "ghcr.io/example/runner:latest",
    identitySecretRef: "runner/test/identity",
    githubCredentialRef: "credential/github/dev",
    ...(input.mergeIntegration !== undefined && { mergeIntegration: input.mergeIntegration }),
  };
  // The same shape the worker passes — only the slots the seam reads are populated.
  const loopInput = {
    pool,
    nativeQueueEnqueuer: enqueuer,
    context,
  } as unknown as RunPlannerLoopInput;

  const seam = mergeQueueEarlyEnqueueSeam(loopInput, context, events, context.orgId ?? "");

  await publishDraftPullRequest({
    pool: pool.asPgPool(),
    eventStore: events,
    secrets,
    githubHttp: http,
    ssh,
    target,
    runId: context.runId,
    specId: context.specId,
    projectId: context.projectId,
    appendEventOrgId: context.orgId ?? "",
    workspacePath: "/workspace/runs/run_42/repo",
    repoUrl: context.repoUrl,
    targetBranch: context.targetBranch,
    runBranch: context.runBranch,
    title: "Tanren: Add fixture",
    githubCredentialRef: "credential/github/dev",
    ...seam,
  });

  return { events };
}

describe("apex v67/v69 — merge_queue enqueue after github.pr.created", () => {
  it("native_queue + enqueuer wired → enqueues immediately + emits merge.scheduled AFTER github.pr.created", async () => {
    const { enqueue, calls } = recordingEnqueuer({ created: true });
    const { events } = await publishWithSeam({ enqueue, mergeIntegration: "native_queue" });

    // The enqueue actually happened — the merge_queue row exists conceptually (the
    // recording enqueuer stood in for `PgMergeQueueModel.enqueue` which is the live
    // INSERT INTO merge_queue (..., status='queued')).
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      projectId: "project_42",
      runId: "run_42",
      specId: "spec_42",
      prUrl: "https://github.com/cat-cave/repo/pull/42",
      prNumber: 42,
    });

    // merge.scheduled was emitted; and CRUCIALLY it fired AFTER github.pr.created (the
    // ordering is the whole point — the queue learns about the PR the instant it exists).
    const types = events.events.map((e) => e.eventType);
    const prCreatedIdx = types.indexOf("github.pr.created");
    const scheduledIdx = types.indexOf("merge.scheduled");
    expect(prCreatedIdx).toBeGreaterThanOrEqual(0);
    expect(scheduledIdx).toBeGreaterThan(prCreatedIdx);

    // The scheduled-event payload carries the same PR coordinates as the queue row.
    const scheduled = events.events[scheduledIdx];
    expect(scheduled?.payload).toEqual({
      prUrl: "https://github.com/cat-cave/repo/pull/42",
      prNumber: 42,
      integration: "native_queue",
    });
    // Doctrine (#723): every appended event carries explicit orgId.
    expect(scheduled?.orgId).toBe("org_42");
    expect(scheduled?.runId).toBe("run_42");
    expect(scheduled?.specId).toBe("spec_42");
    expect(scheduled?.projectId).toBe("project_42");
  });

  it("idempotency: enqueuer returns created:false → enqueue still fires, merge.scheduled is SKIPPED", async () => {
    // A re-published PR (writer-rework re-enters publishCleanedDraftPr per iteration)
    // hits the partial-unique-index dedup in PgMergeQueueModel.enqueue and gets back
    // {created: false}. The seam must NOT re-emit merge.scheduled — the original
    // event already fired at the original commit time; a re-emit would double-wake
    // observers for the same logical event.
    const { enqueue, calls } = recordingEnqueuer({ created: false });
    const { events } = await publishWithSeam({ enqueue, mergeIntegration: "native_queue" });

    // The enqueue STILL runs (cheap, idempotent on PgMergeQueueModel's partial unique index).
    expect(calls).toHaveLength(1);
    expect(events.events.some((e) => e.eventType === "merge.scheduled")).toBe(false);
    // github.pr.created still fires (the underlying durable PR-open signal is the gate
    // for the enqueue, not the scheduled event).
    expect(events.events.some((e) => e.eventType === "github.pr.created")).toBe(true);
  });

  it("direct_merge project → seam is no-op (no early enqueue, no merge.scheduled)", async () => {
    const { enqueue, calls } = recordingEnqueuer({ created: true });
    const { events } = await publishWithSeam({ enqueue, mergeIntegration: "direct_merge" });

    // direct_merge has NO queue concept — the late-path mergeForRun does an immediate
    // host merge. An early enqueue would race the coordinator. The seam must skip.
    expect(calls).toHaveLength(0);
    expect(events.events.some((e) => e.eventType === "merge.scheduled")).toBe(false);
    expect(events.events.some((e) => e.eventType === "github.pr.created")).toBe(true);
  });

  it("external_reviewer project → seam is no-op", async () => {
    const { enqueue, calls } = recordingEnqueuer({ created: true });
    await publishWithSeam({ enqueue, mergeIntegration: "external_reviewer" });
    expect(calls).toHaveLength(0);
  });

  it("native_queue but no enqueuer wired (unit test path) → seam is no-op (no throw)", async () => {
    // A no-DB unit run omits `input.nativeQueueEnqueuer`; the seam must skip cleanly
    // rather than throw — production always wires it via buildNativeQueueEnqueuer(pool).
    const { events } = await publishWithSeam({ enqueue: undefined, mergeIntegration: "native_queue" });
    expect(events.events.some((e) => e.eventType === "merge.scheduled")).toBe(false);
    expect(events.events.some((e) => e.eventType === "github.pr.created")).toBe(true);
  });

  it("mergeIntegration absent (test-injected context) → seam is no-op (safe default)", async () => {
    // PlannerRunContext.mergeIntegration is optional for the test seam; absent ⇒ the
    // late-path behavior (no early enqueue) is preserved. Production always sets it
    // (runExecutionContext.ts threads it from projectConfig.mergeIntegration).
    const { enqueue, calls } = recordingEnqueuer({ created: true });
    await publishWithSeam({ enqueue, mergeIntegration: undefined });
    expect(calls).toHaveLength(0);
  });
});
