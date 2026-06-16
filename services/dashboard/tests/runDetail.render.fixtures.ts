// runDetail.render.fixtures — shared mock data, orchestrator fetch stubs, and
// the app builder for the run-detail render tests. Extracted from
// runDetail.render.test.ts to keep that file under the 500-line cap.
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
export const RUN_ID = "run_medium_001";

export const RUN_DETAIL: RunDetail = {
  run: {
    runId: RUN_ID,
    specId: "spec_settings",
    projectId: PROJECT.projectId,
    branch: "tanren/spec_settings",
    trigger: "operator",
    status: "running",
    outcome: null,
    startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    endedAt: null,
    prUrl: "https://github.com/cat-cave/tanren-fixture-medium/pull/142",
  },
  spec: {
    specId: "spec_settings",
    title: "persist theme to localStorage",
    description: "wire the settings dropdown into localStorage",
    behaviorIds: ["bhv_persist", "bhv_no_ssr_mismatch"],
    milestoneId: "m4",
  },
  tasks: [
    {
      taskId: "plan_1",
      runId: RUN_ID,
      kind: "plan",
      parentTaskId: null,
      title: "decompose the spec",
      status: "done",
      outcome: "passed",
      failureKind: null,
      attempt: 0,
      cli: "codex",
      model: "gpt-5",
      startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      endedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
    },
    {
      taskId: "write_1",
      runId: RUN_ID,
      kind: "write",
      parentTaskId: "plan_1",
      title: "wire localStorage persistence",
      status: "done",
      outcome: "passed",
      failureKind: null,
      attempt: 0,
      cli: "codex",
      model: "gpt-5",
      startedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
      endedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    },
    // The rejection loop: an auditor-rejected attempt of subtask 2 ...
    {
      taskId: "write_2_rej",
      runId: RUN_ID,
      kind: "write",
      parentTaskId: "plan_1",
      title: "add profile-sync hook",
      status: "done",
      outcome: "rejected_by_auditor",
      failureKind: "auditor_disagreement",
      attempt: 0,
      cli: "codex",
      model: "gpt-5",
      startedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
      endedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    },
    // ... then the live retry.
    {
      taskId: "write_2",
      runId: RUN_ID,
      kind: "write",
      parentTaskId: "plan_1",
      title: "add profile-sync hook (retry)",
      status: "running",
      outcome: null,
      failureKind: null,
      attempt: 1,
      cli: "codex",
      model: "gpt-5",
      startedAt: new Date(Date.now() - 1 * 60_000).toISOString(),
      endedAt: null,
    },
    {
      taskId: "audit_1",
      runId: RUN_ID,
      kind: "audit",
      parentTaskId: null,
      title: "audit the change",
      status: "queued",
      outcome: null,
      failureKind: null,
      attempt: 0,
      cli: "codex",
      model: "gpt-5",
      startedAt: null,
      endedAt: null,
    },
  ],
  recentEvents: [
    {
      id: 1,
      ts: new Date().toISOString(),
      runId: RUN_ID,
      taskId: "write_2",
      specId: "spec_settings",
      projectId: PROJECT.projectId,
      eventType: "writer.intent",
      payload: { intent: "wire the profile-sync hook behind a feature flag" },
      redactedPaths: [],
    },
    {
      id: 2,
      ts: new Date().toISOString(),
      runId: RUN_ID,
      taskId: "write_2",
      specId: "spec_settings",
      projectId: PROJECT.projectId,
      eventType: "tool.call",
      payload: { tool: "edit_file", arg: "useProfileSync.ts", output: "+24 -1" },
      redactedPaths: [],
    },
    {
      id: 3,
      ts: new Date().toISOString(),
      runId: RUN_ID,
      taskId: "write_2",
      specId: "spec_settings",
      projectId: PROJECT.projectId,
      eventType: "secret.scan",
      payload: {},
      redactedPaths: ["token"],
    },
    {
      id: 4,
      ts: new Date().toISOString(),
      runId: RUN_ID,
      taskId: "write_1",
      specId: "spec_settings",
      projectId: PROJECT.projectId,
      eventType: "writer.deferral",
      payload: {
        tag: "follow-up",
        title: "extract a useLocalStorage hook",
        detail: "duplicated localStorage access across two components",
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
      cachedInputTokens: 400,
      cacheCreationTokens: 0,
      outputTokens: 600,
      reasoningOutputTokens: 0,
      totalTokens: 1800,
      costUsd: "0.0240",
      billingMode: "per_token",
      costBasis: "provider_response",
      recordedAt: new Date().toISOString(),
    },
    {
      id: 2,
      runId: RUN_ID,
      taskId: "write_2",
      projectId: PROJECT.projectId,
      cli: "claude",
      provider: "anthropic",
      model: "claude-sonnet",
      inputTokens: 800,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 300,
      reasoningOutputTokens: 0,
      totalTokens: 1100,
      costUsd: null,
      billingMode: "subscription",
      costBasis: "ccusage",
      recordedAt: new Date().toISOString(),
    },
    {
      id: 3,
      runId: RUN_ID,
      taskId: "audit_1",
      projectId: PROJECT.projectId,
      cli: "ollama",
      provider: "self",
      model: "qwen-local",
      inputTokens: 400,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 120,
      reasoningOutputTokens: 0,
      totalTokens: 520,
      costUsd: "0.0000",
      billingMode: "self_hosted",
      costBasis: "unknown",
      recordedAt: new Date().toISOString(),
    },
  ],
  insights: [{ kind: "pace_anomaly", specTitle: "persist theme to localStorage" }],
  forgeThread: null,
};

export function stubPool(): pg.Pool {
  return { query: async () => ({ rows: [{ ok: 1 }], rowCount: 1 }) } as unknown as pg.Pool;
}

export function mockOrchestrator(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/auth/me")) {
      return new Response(JSON.stringify({ userId: "u1", csrfToken: "c", expiresAt: "2030-01-01" }), { status: 200 });
    }
    if (url.endsWith("/orgs")) {
      return new Response(JSON.stringify({ orgs: [ORG] }), { status: 200 });
    }
    if (url.endsWith(`/orgs/${ORG.id}/projects`)) {
      return new Response(JSON.stringify({ projects: [PROJECT] }), { status: 200 });
    }
    // run list (used to resolve runId → project)
    if (url.endsWith(`/projects/${PROJECT.projectId}/runs`)) {
      return new Response(
        JSON.stringify({
          items: [
            {
              ...RUN_DETAIL.run,
              specTitle: RUN_DETAIL.spec.title,
              costTotalUsd: "0.0240",
              lastEventAt: null,
              needsReview: false,
            },
          ],
        }),
        { status: 200 },
      );
    }
    // run detail
    if (url.includes(`/runs/${RUN_ID}`) && !url.includes("/stream")) {
      return new Response(JSON.stringify(RUN_DETAIL), { status: 200 });
    }
    if (url.endsWith("/healthz")) {
      return new Response("ok", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
}

export async function build() {
  return createApp({ pool: stubPool(), skipMigrate: true });
}

export function mockOrchestratorWithProject(previewUrlPattern?: string): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/auth/me")) {
      return new Response(JSON.stringify({ userId: "u1", csrfToken: "c", expiresAt: "2030-01-01" }), { status: 200 });
    }
    if (url.endsWith("/orgs")) {
      return new Response(JSON.stringify({ orgs: [ORG] }), { status: 200 });
    }
    if (url.endsWith(`/orgs/${ORG.id}/projects`)) {
      return new Response(JSON.stringify({ projects: [PROJECT] }), { status: 200 });
    }
    // project detail (getProject) — carries the merged config incl. preview pattern
    if (url.endsWith(`/orgs/${ORG.id}/projects/${PROJECT.projectId}`)) {
      return new Response(
        JSON.stringify({
          ...PROJECT,
          defaultBranch: "main",
          runnerImage: null,
          allocator: "local_docker",
          config: {
            version: 1,
            routing: {},
            mergeIntegration: "not_configured",
            ...(previewUrlPattern === undefined ? {} : { previewUrlPattern }),
          },
        }),
        { status: 200 },
      );
    }
    if (url.endsWith(`/projects/${PROJECT.projectId}/runs`)) {
      return new Response(
        JSON.stringify({
          items: [
            {
              ...RUN_DETAIL.run,
              specTitle: RUN_DETAIL.spec.title,
              costTotalUsd: "0.0240",
              lastEventAt: null,
              needsReview: false,
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.includes(`/runs/${RUN_ID}`) && !url.includes("/stream")) {
      return new Response(JSON.stringify(RUN_DETAIL), { status: 200 });
    }
    if (url.endsWith("/healthz")) {
      return new Response("ok", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
}
