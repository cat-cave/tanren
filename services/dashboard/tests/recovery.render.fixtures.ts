// recovery.render.fixtures — shared mock data, the configurable orchestrator
// fetch stub (with the recoveryCalls recorder), and the app builder for the
// recovery render tests. Extracted from recovery.render.test.ts to keep that
// file under the 500-line cap.
import type pg from "pg";
import { vi } from "vitest";
import { createApp } from "../src/main.js";
import type { RunDetail } from "../src/api/types.js";

export const ORG = {
  id: "org_acme",
  kind: "github_org",
  login: "cat-cave",
  displayName: "Cat Cave",
  role: "org:admin",
};
export const PROJECT = {
  projectId: "project_medium",
  name: "tanren-fixture-medium",
  repoUrl: "https://github.com/cat-cave/tanren-fixture-medium",
  defaultBranch: "main",
  runnerImage: null,
  allocator: "local_docker",
};
export const RUN_ID = "run_a347d4";
export const SPEC_ID = "spec_a4f";

export const RUN_DETAIL: RunDetail = {
  run: {
    runId: RUN_ID,
    specId: SPEC_ID,
    projectId: PROJECT.projectId,
    branch: "tanren/no-ssr-flash",
    trigger: "dashboard",
    status: "halted",
    outcome: "retry_budget_exhausted",
    startedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
    endedAt: new Date().toISOString(),
    prUrl: null,
  },
  spec: {
    specId: SPEC_ID,
    title: "no SSR theme flash",
    description: "behavior 5 — no client flash on first paint",
    behaviorIds: ["bhv_no_flash"],
    milestoneId: "m4",
  },
  tasks: [
    {
      taskId: "plan_1",
      runId: RUN_ID,
      kind: "plan",
      parentTaskId: null,
      title: "decompose",
      status: "done",
      outcome: "rejected_by_auditor",
      failureKind: "auditor_disagreement",
      attempt: 3,
      cli: "codex",
      model: "gpt-5",
      startedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
      endedAt: new Date().toISOString(),
    },
    {
      taskId: "write_1",
      runId: RUN_ID,
      kind: "write",
      parentTaskId: "plan_1",
      title: "wire no-flash guard",
      status: "done",
      outcome: "passed",
      failureKind: null,
      attempt: 0,
      cli: "codex",
      model: "gpt-5",
      startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      endedAt: new Date(Date.now() - 8 * 60_000).toISOString(),
    },
  ],
  recentEvents: [
    {
      id: 1,
      ts: new Date(Date.now() - 9 * 60_000).toISOString(),
      runId: RUN_ID,
      taskId: "write_1",
      specId: SPEC_ID,
      projectId: PROJECT.projectId,
      eventType: "workspace.git_captured",
      payload: {
        workspacePath: "/w",
        commits: [{ sha: "9f3a2b4", message: "wire guard" }],
        diffBytes: 100,
      },
      redactedPaths: [],
    },
    {
      id: 2,
      ts: new Date(Date.now() - 5 * 60_000).toISOString(),
      runId: RUN_ID,
      taskId: "plan_1",
      specId: SPEC_ID,
      projectId: PROJECT.projectId,
      eventType: "auditor.rejected",
      payload: {
        runId: RUN_ID,
        auditTaskId: "audit_1",
        reason: "race still possible client-side",
        outstandingBehaviorIds: ["bhv_no_flash"],
        recommendedAction: "revise",
      },
      redactedPaths: [],
    },
    {
      id: 3,
      ts: new Date(Date.now() - 4 * 60_000).toISOString(),
      runId: RUN_ID,
      taskId: "plan_1",
      specId: SPEC_ID,
      projectId: PROJECT.projectId,
      eventType: "planner.rerequested",
      payload: {
        runId: RUN_ID,
        plannerTaskId: "plan_1",
        producer: "auditor",
        rejectionReason: "race still possible",
        behaviorIdsFailed: ["bhv_no_flash"],
        plannerRerunCount: 3,
      },
      redactedPaths: [],
    },
  ],
  costs: [
    {
      id: 1,
      runId: RUN_ID,
      taskId: "write_1",
      projectId: PROJECT.projectId,
      cli: "codex",
      provider: "openai",
      model: "gpt-5",
      inputTokens: 1200,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 600,
      reasoningOutputTokens: 0,
      totalTokens: 1800,
      costUsd: "0.8400",
      billingMode: "per_token",
      costBasis: "provider_response",
      recordedAt: new Date().toISOString(),
    },
  ],
  insights: [],
  forgeThread: null,
};

export const SPECS = [
  {
    specId: SPEC_ID,
    projectId: PROJECT.projectId,
    title: "no SSR theme flash",
    description: "",
    acceptanceCriteria: [],
    dependsOn: [],
    status: "in_flight",
  },
  {
    specId: "spec_pick",
    projectId: PROJECT.projectId,
    title: "pick list ui",
    description: "",
    acceptanceCriteria: [],
    dependsOn: [SPEC_ID],
    status: "open",
  },
  {
    specId: "spec_scan",
    projectId: PROJECT.projectId,
    title: "scan item to tote",
    description: "",
    acceptanceCriteria: [],
    dependsOn: [SPEC_ID],
    status: "open",
  },
];

export function stubPool(): pg.Pool {
  return { query: async () => ({ rows: [{ ok: 1 }], rowCount: 1 }) } as unknown as pg.Pool;
}

export let recoveryCalls: Array<{ url: string; method: string; body: string | undefined }> = [];

export function mockOrchestrator(
  opts: { recoverable?: boolean; lastGoodCommit?: string | null; runActionOk?: boolean } = {},
): void {
  const recoverable = opts.recoverable ?? true;
  const lastGoodCommit = opts.lastGoodCommit === undefined ? "9f3a2b4" : opts.lastGoodCommit;
  const runActionOk = opts.runActionOk ?? true;
  recoveryCalls = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (url.endsWith("/auth/me"))
      return new Response(JSON.stringify({ userId: "u1", csrfToken: "c", expiresAt: "2030-01-01" }), { status: 200 });
    if (url.endsWith("/orgs")) return new Response(JSON.stringify({ orgs: [ORG] }), { status: 200 });
    // The halted-run index itself legitimately lists projects and their runs;
    // run-detail/recovery routing below uses the location endpoint instead.
    if (url.endsWith(`/orgs/${ORG.id}/projects`))
      return new Response(JSON.stringify({ projects: [PROJECT] }), { status: 200 });
    if (url.endsWith(`/projects/${PROJECT.projectId}/runs`)) {
      const run = recoverable ? RUN_DETAIL.run : { ...RUN_DETAIL.run, status: "running", outcome: null };
      return new Response(
        JSON.stringify({
          items: [
            { ...run, specTitle: RUN_DETAIL.spec.title, costTotalUsd: "0.84", lastEventAt: null, needsReview: false },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.endsWith(`/orgs/${ORG.id}/runs/${RUN_ID}/location`))
      return new Response(JSON.stringify({ orgId: ORG.id, projectId: PROJECT.projectId }), { status: 200 });
    if (/\/orgs\/[^/]+\/runs\/[^/]+\/location$/u.test(url)) {
      return new Response(JSON.stringify({ error: "run_not_found" }), { status: 404 });
    }
    if (url.endsWith(`/projects/${PROJECT.projectId}/specs`))
      return new Response(JSON.stringify({ specs: SPECS }), { status: 200 });
    // recovery action POST proxies
    if (url.includes("/recovery/") && method === "POST") {
      recoveryCalls.push({
        url,
        method,
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      if (!runActionOk)
        return new Response(JSON.stringify({ error: "run_not_recoverable", message: "nope" }), {
          status: 409,
        });
      if (url.endsWith("/recovery/revise"))
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              action: "revise_spec",
              runId: RUN_ID,
              specId: SPEC_ID,
              editHref: `/projects/${PROJECT.projectId}/specs/${SPEC_ID}/edit?recoverRunId=${RUN_ID}`,
            },
          }),
          { status: 200 },
        );
      if (url.endsWith("/recovery/replan"))
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              action: "replan_with_steering",
              runId: RUN_ID,
              specId: SPEC_ID,
              replanRunId: "run_replan_1",
              plannerTaskId: "task_p1",
            },
          }),
          { status: 200 },
        );
      if (url.endsWith("/recovery/rollback"))
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              action: "rollback_to_commit",
              runId: RUN_ID,
              specId: SPEC_ID,
              commitSha: "9f3a2b4",
              replanRunId: "run_rb_1",
            },
          }),
          { status: 200 },
        );
      if (url.endsWith("/recovery/inspection-thread"))
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              action: "open_inspection_thread",
              runId: RUN_ID,
              specId: SPEC_ID,
              threadId: "forge_thread_xyz",
            },
          }),
          { status: 200 },
        );
    }
    // recovery context GET
    if (url.includes("/recovery") && method === "GET") {
      return new Response(
        JSON.stringify({
          runId: RUN_ID,
          specId: SPEC_ID,
          projectId: PROJECT.projectId,
          status: "halted",
          outcome: "retry_budget_exhausted",
          lastGoodCommit,
        }),
        { status: 200 },
      );
    }
    // run detail
    if (url.includes(`/runs/${RUN_ID}`) && !url.includes("/stream") && !url.includes("/recovery")) {
      const detail = recoverable
        ? RUN_DETAIL
        : { ...RUN_DETAIL, run: { ...RUN_DETAIL.run, status: "running", outcome: null } };
      return new Response(JSON.stringify(detail), { status: 200 });
    }
    if (url.endsWith("/healthz")) return new Response("ok", { status: 200 });
    return new Response("not found", { status: 404 });
  });
}

export async function build() {
  return createApp({ pool: stubPool(), skipMigrate: true });
}
