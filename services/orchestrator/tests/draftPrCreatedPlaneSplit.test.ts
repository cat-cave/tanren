// apex v86 regression: after a successful GitHub draft-PR open, the post-PR-open
// durable writes (`github.pr.created` + `merge_queue` + `merge.scheduled`) MUST
// route through `RunStateWriter.recordDraftPrCreated` — NEVER through a direct
// `PgEventStore` on the worker's de-privileged pool.
//
// Live failure: `github.branch.pushed` OK, POST /pulls 201, then
// `github.failed` with `permission denied for table events` on
// `publish_draft_pull_request` — because `mergeQueueEarlyEnqueueSeam` opened
// `runWithOrgScope(dataplanePool) + new PgEventStore(client)` while baseline
// 0000 REVOKEs INSERT on `events` from `tanren_dataplane`. The draft PR sat
// forever; redrives left it DRAFT.
//
// This test mirrors the live deny: any direct `events` INSERT on the pool
// throws 42501. With a writer wired, publish must still succeed and the writer
// must receive the atomic recordDraftPrCreated call.

import { describe, expect, it } from "vitest";
import { RecordingSsh, ScriptedGitHubHttp } from "./helpers/githubDraftPrFakes.js";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import { publishDraftPullRequest } from "../src/engine/workflow/githubDraftPr.js";
import { mergeQueueEarlyEnqueueSeam } from "../src/engine/workflow/plannerRunSeams.js";
import type { PlannerRunContext, RunPlannerLoopInput } from "../src/engine/workflow/plannerRun.js";
import type {
  RecordDraftPrCreatedInput,
  RecordDraftPrCreatedOutcome,
  RunStateWriter,
} from "../src/engine/contracts/runStateWriter.js";
import type pg from "pg";

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};

/**
 * Pool that DENIES every `events` INSERT with the live dataplane SQLSTATE —
 * so a regression that reopens `PgEventStore` on the worker pool fails loud.
 */
class DenyingEventsPool {
  readonly queries: string[] = [];
  async query(sql: string, _params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
    this.queries.push(sql);
    const text = sql.trim();
    if (
      text.startsWith("BEGIN") ||
      text.startsWith("SET LOCAL") ||
      text.startsWith("COMMIT") ||
      text.startsWith("ROLLBACK") ||
      text.startsWith("SELECT set_config")
    ) {
      return { rows: [], rowCount: 0 };
    }
    // Mirror `tanren_dataplane` REVOKE: any events write is 42501.
    if (/INSERT\s+INTO\s+events\b/iu.test(text) || (text.startsWith("INSERT INTO") && text.includes("event_type"))) {
      throw Object.assign(new Error("permission denied for table events"), { code: "42501" });
    }
    // UPDATE runs SET pr_url is also revoked on dataplane — but the production
    // path routes it through runStateWriter.setRunPrUrl; deny here too so a
    // fall-through would surface.
    if (/UPDATE\s+runs\b/iu.test(text)) {
      throw Object.assign(new Error("permission denied for table runs"), { code: "42501" });
    }
    return { rows: [], rowCount: 0 };
  }
  async connect(): Promise<{
    query: DenyingEventsPool["query"];
    release: () => void;
  }> {
    return { query: this.query.bind(this), release: () => {} };
  }
  asPgPool(): pg.Pool {
    return this as unknown as pg.Pool;
  }
}

/** Writer that records `recordDraftPrCreated` + `setRunPrUrl` (control-plane path). */
class RecordingPlaneSplitWriter {
  readonly draftPrCreated: RecordDraftPrCreatedInput[] = [];
  readonly prUrls: Array<{ runId: string; prUrl: string }> = [];
  readonly appends: string[] = [];

  async append(input: { eventType: string }): Promise<void> {
    this.appends.push(input.eventType);
  }
  async setRunPrUrl(input: { runId: string; prUrl: string }): Promise<void> {
    this.prUrls.push({ runId: input.runId, prUrl: input.prUrl });
  }
  async recordDraftPrCreated(input: RecordDraftPrCreatedInput): Promise<RecordDraftPrCreatedOutcome> {
    this.draftPrCreated.push(input);
    return { created: true };
  }
  asRunStateWriter(): RunStateWriter {
    return this as unknown as RunStateWriter;
  }
}

describe("apex v86 — post-PR-open writes route through RunStateWriter (plane-split)", () => {
  it("publishDraftPullRequest succeeds when the pool denies events INSERT (writer owns the atomic block)", async () => {
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: "credential/github/dev", value: "ghp_test" });
    const http = new ScriptedGitHubHttp([
      { status: 200, body: [] },
      {
        status: 201,
        body: {
          number: 1,
          html_url: "https://github.com/cat-cave/linky86/pull/1",
          draft: true,
          base: { ref: "main" },
        },
      },
    ]);
    const pool = new DenyingEventsPool();
    const writer = new RecordingPlaneSplitWriter();
    // Pre-PR events (credential.*, github.branch.pushed) ride the eventStore —
    // the same control-plane writer in production; FakeEventStore here so they
    // don't touch the denying pool.
    const eventStore = new FakeEventStore();

    const context: PlannerRunContext = {
      runId: "run_v86",
      specId: "spec_v86",
      projectId: "project_v86",
      orgId: "org_v86",
      repoUrl: "https://github.com/cat-cave/linky86.git",
      targetBranch: "main",
      runBranch: "tanren/scaffold-8973ab2b",
      specTitle: "Scaffold",
      specDescription: "",
      acceptanceCriteria: [],
      runnerImage: "ghcr.io/example/runner:latest",
      identitySecretRef: "runner/test/identity",
      githubCredentialRef: "credential/github/dev",
      mergeIntegration: "native_queue",
    };
    const loopInput = {
      pool: pool.asPgPool(),
      runStateWriter: writer.asRunStateWriter(),
      // Even if the legacy on-client enqueuer is wired (production always does),
      // the writer path must win — otherwise we re-open the v86 hole.
      nativeQueueOnClientEnqueuer: async () => {
        throw new Error("on-client enqueuer must not run when runStateWriter is wired");
      },
      context,
    } as unknown as RunPlannerLoopInput;

    const seam = mergeQueueEarlyEnqueueSeam(loopInput, context, eventStore, context.orgId);

    const result = await publishDraftPullRequest({
      pool: pool.asPgPool(),
      eventStore,
      runStateWriter: writer.asRunStateWriter(),
      orgId: context.orgId,
      appendEventOrgId: context.orgId,
      secrets,
      githubHttp: http,
      ssh: new RecordingSsh(),
      target,
      runId: context.runId,
      specId: context.specId,
      projectId: context.projectId,
      workspacePath: "/workspace/runs/run_v86/repo",
      repoUrl: context.repoUrl,
      targetBranch: context.targetBranch,
      runBranch: context.runBranch,
      title: "Tanren: Scaffold",
      githubCredentialRef: "credential/github/dev",
      ...seam,
    });

    expect(result.prUrl).toBe("https://github.com/cat-cave/linky86/pull/1");
    expect(result.prNumber).toBe(1);
    // The durable post-PR-open block went through the writer — not the pool.
    expect(writer.draftPrCreated).toHaveLength(1);
    expect(writer.draftPrCreated[0]).toMatchObject({
      orgId: "org_v86",
      runId: "run_v86",
      prUrl: "https://github.com/cat-cave/linky86/pull/1",
      prNumber: 1,
      branch: "tanren/scaffold-8973ab2b",
    });
    // pr_url stamp also routed through the writer (pool UPDATE is denied).
    expect(writer.prUrls).toEqual([{ runId: "run_v86", prUrl: "https://github.com/cat-cave/linky86/pull/1" }]);
    // Pre-PR ledger still visible on the eventStore (credential + branch push).
    const types = eventStore.events.map((e) => e.eventType);
    expect(types).toContain("github.branch.pushed");
    // github.pr.created is owned by the atomic writer block — NOT the inline append.
    expect(types).not.toContain("github.pr.created");
    // No github.failed — the permission deny never fired.
    expect(types).not.toContain("github.failed");
  });

  it("seam with no writer falls back to enqueuer path (never opens pool events INSERT)", async () => {
    // Unit-test path: no runStateWriter. Must use enqueueAfterCreate + eventStore,
    // never runWithOrgScope + PgEventStore on the denying pool.
    const pool = new DenyingEventsPool();
    const eventStore = new FakeEventStore();
    const enqueueCalls: Array<{ prNumber: number }> = [];

    const context: PlannerRunContext = {
      runId: "run_legacy",
      specId: "spec_legacy",
      projectId: "project_legacy",
      orgId: "org_legacy",
      repoUrl: "https://github.com/cat-cave/linky86.git",
      targetBranch: "main",
      runBranch: "tanren/run_legacy",
      specTitle: "Legacy",
      specDescription: "",
      acceptanceCriteria: [],
      runnerImage: "ghcr.io/example/runner:latest",
      identitySecretRef: "runner/test/identity",
      githubCredentialRef: "credential/github/dev",
      mergeIntegration: "native_queue",
    };
    const loopInput = {
      pool: pool.asPgPool(),
      nativeQueueEnqueuer: async (input: { prNumber: number }) => {
        enqueueCalls.push({ prNumber: input.prNumber });
        return { created: true };
      },
      context,
    } as unknown as RunPlannerLoopInput;

    const seam = mergeQueueEarlyEnqueueSeam(loopInput, context, eventStore, context.orgId);

    // No runStateWriter → setRunPrUrl falls through to pool UPDATE which is denied.
    // That is intentional for the operator route (privileged pool); the production
    // worker always wires the writer. Here we only assert the seam does not take
    // the atomic-on-pool path: if it did, events INSERT would 42501 before PR url.
    // Drive only the seam callback after a synthetic PR open is not needed —
    // assert the seam shape: enqueueAfterCreate present, postPrCreatedAtomicWrites absent.
    expect(seam.postPrCreatedAtomicWrites).toBeUndefined();
    expect(seam.enqueueAfterCreate).toBeTypeOf("function");

    // Fire the legacy enqueueAfterCreate after github.pr.created would have been
    // appended by publishDraftPullRequest's non-atomic branch (eventStore path).
    await eventStore.append({
      runId: context.runId,
      specId: context.specId,
      projectId: context.projectId,
      orgId: context.orgId,
      eventType: "github.pr.created",
      payload: {
        repoUrl: context.repoUrl,
        branch: context.runBranch,
        targetBranch: context.targetBranch,
        prUrl: "https://github.com/cat-cave/linky86/pull/2",
        prNumber: 2,
      },
    });
    await seam.enqueueAfterCreate!({
      prUrl: "https://github.com/cat-cave/linky86/pull/2",
      prNumber: 2,
    });
    expect(enqueueCalls).toEqual([{ prNumber: 2 }]);
    expect(eventStore.events.map((e) => e.eventType)).toEqual(["github.pr.created", "merge.scheduled"]);
    // The denying pool must never have seen an events INSERT.
    expect(pool.queries.some((q) => /INSERT\s+INTO\s+events/iu.test(q))).toBe(false);
  });
});
