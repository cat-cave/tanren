// projects.render.fixtures — shared mock data, the orchestrator fetch stub, and
// the app builder for the project-view render tests. Extracted from
// projects.render.test.ts to keep that file under the 500-line cap.
import type pg from "pg";
import { vi } from "vitest";
import { createApp } from "../src/main.js";

const ORG = {
  id: "org_acme",
  kind: "github_org",
  login: "cat-cave",
  displayName: "Cat Cave",
  role: "org:admin",
};
const PROJECT = {
  projectId: "project_easy",
  name: "tanren-fixture-easy",
  repoUrl: "https://github.com/cat-cave/tanren-fixture-easy",
  defaultBranch: "main",
  runnerImage: null,
  allocator: "local_docker",
};

const RUNS = [
  {
    runId: "run_live",
    specId: "spec_a",
    projectId: "project_easy",
    branch: "main",
    trigger: "dashboard",
    status: "running",
    outcome: null,
    startedAt: "2026-05-28T10:00:00.000Z",
    endedAt: null,
    prUrl: null,
    specTitle: "supplier scorecard",
    costTotalUsd: "12.5",
    lastEventAt: "2026-05-28T10:05:00.000Z",
    needsReview: false,
  },
  {
    runId: "run_review",
    specId: "spec_b",
    projectId: "project_easy",
    branch: "main",
    trigger: "dashboard",
    status: "completed",
    outcome: "ok",
    startedAt: "2026-05-28T09:00:00.000Z",
    endedAt: "2026-05-28T09:30:00.000Z",
    prUrl: "https://github.com/cat-cave/tanren-fixture-easy/pull/142",
    specTitle: "edi mapping ui",
    costTotalUsd: "30.0",
    lastEventAt: "2026-05-28T09:30:00.000Z",
    needsReview: true,
  },
];

const INSIGHTS = [
  {
    id: "ins_1",
    kind: "retry_hotspot",
    projectId: "project_easy",
    severity: "warn",
    title: "writer retries on supplier-scorecard class",
    body: "4 retries in 7 days on codex/gpt-5.5 for this spec class.",
    payload: { kind: "retry_hotspot", specId: "spec_a" },
    actions: [
      {
        label: "switch writer · this spec class",
        toolCall: { tool: "tanren.create_spec", args: {} },
      },
    ],
    computedAt: "2026-05-28T08:00:00.000Z",
    acknowledgedAt: null,
  },
  {
    // review_stall — now a supported kind that MUST render.
    id: "ins_2",
    kind: "review_stall",
    projectId: "project_easy",
    severity: "warn",
    title: "review stall on auth PR",
    body: "PR #42 awaiting review for 3d with no approval or merge.",
    payload: { kind: "review_stall", specId: "spec_a", prNumber: 42 },
    actions: [],
    computedAt: "2026-05-28T08:00:00.000Z",
    acknowledgedAt: null,
  },
];

const MILESTONES = [
  {
    id: "m_7",
    projectId: "project_easy",
    label: "M7",
    name: "perf",
    description: null,
    orderIndex: 7,
    eta: "2026-06-18T00:00:00.000Z",
    status: "in_flight",
  },
];

const FEED = [
  {
    id: 10,
    ts: "2026-05-28T10:05:00.000Z",
    runId: "run_live",
    taskId: "task_1",
    specId: "spec_a",
    projectId: "project_easy",
    eventType: "task.write.started",
    redactedPaths: [],
  },
];

const SPECS = [
  {
    specId: "spec_a",
    projectId: "project_easy",
    title: "supplier scorecard",
    description: "export a supplier scorecard",
    acceptanceCriteria: ["renders a table", "exports csv"],
    dependsOn: [],
    status: "in_flight",
  },
];

const PERSONAS = [{ id: "persona_1", name: "buyer", description: "" }];
const BEHAVIORS = [{ id: "beh_1", personaId: "persona_1", title: "can export scorecard", description: null }];

const PROJECT_DETAIL = {
  ...PROJECT,
  config: {
    version: 1,
    routing: {
      plan: {
        chain: [
          {
            cli: "codex",
            model: "gpt-5.5",
            authRef: "vault://dev/codex/chatgpt",
            healthHint: "ok",
          },
        ],
      },
      write: { chain: [] },
      check: { chain: [] },
      audit: { chain: [] },
      demo: { chain: [] },
      forge: { chain: [] },
    },
    escapeHatches: {
      maxWriterIterPerSubtask: 5,
      maxRetriesPerTransientFailure: 3,
    },
  },
};

export const patchCalls: Array<{ url: string; body: unknown }> = [];
export const toolCalls: Array<{ url: string; body: unknown }> = [];
export const specCreateCalls: Array<{ url: string; body: unknown }> = [];

export function stubPool(): pg.Pool {
  return { query: async () => ({ rows: [{ ok: 1 }], rowCount: 1 }) } as unknown as pg.Pool;
}

export function mockOrchestrator(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));

    if (url.endsWith("/auth/me")) {
      return new Response(JSON.stringify({ userId: "u1", csrfToken: "c", expiresAt: "2030-01-01" }), { status: 200 });
    }
    if (url.endsWith("/orgs")) {
      return new Response(JSON.stringify({ orgs: [ORG] }), { status: 200 });
    }
    if (/\/orgs\/[^/]+\/projects$/u.test(url)) {
      return new Response(JSON.stringify({ projects: [PROJECT] }), { status: 200 });
    }
    if (url.endsWith("/projects/project_easy") && method === "GET") {
      return new Response(JSON.stringify(PROJECT_DETAIL), { status: 200 });
    }
    if (/\/orgs\/[^/]+\/credentials$/u.test(url) && method === "GET") {
      return new Response(
        JSON.stringify({
          credentials: [
            {
              ref: "credential/codex/org/o/c",
              kind: "codex_chatgpt_auth",
              scope: "org",
              ownerId: "o",
              createdAt: "2026-05-01",
            },
            {
              ref: "credential/github/org/o/g",
              kind: "github_token",
              scope: "org",
              ownerId: "o",
              createdAt: "2026-05-01",
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.endsWith("/projects/project_easy") && method === "PATCH") {
      patchCalls.push({ url, body });
      return new Response(JSON.stringify({ projectId: "project_easy", config: body.config }), {
        status: 200,
      });
    }
    if (url.includes("/runs")) {
      return new Response(JSON.stringify({ items: RUNS }), { status: 200 });
    }
    if (url.includes("/insights")) {
      return new Response(JSON.stringify({ insights: INSIGHTS }), { status: 200 });
    }
    if (url.includes("/milestones")) {
      return new Response(JSON.stringify({ milestones: MILESTONES }), { status: 200 });
    }
    if (url.includes("/feed")) {
      return new Response(JSON.stringify({ items: FEED }), { status: 200 });
    }
    if (url.endsWith("/specs") && method === "GET") {
      return new Response(JSON.stringify({ specs: SPECS }), { status: 200 });
    }
    if (url.endsWith("/specs") && method === "POST") {
      specCreateCalls.push({ url, body });
      return new Response(JSON.stringify({ specId: "spec_new", ...body }), { status: 201 });
    }
    if (url.includes("/personas")) {
      return new Response(JSON.stringify({ personas: PERSONAS }), { status: 200 });
    }
    if (url.includes("/behaviors")) {
      return new Response(JSON.stringify({ behaviors: BEHAVIORS }), { status: 200 });
    }
    if (url.includes("/forge/threads") && url.endsWith("/threads")) {
      return new Response(JSON.stringify({ id: "thread_1" }), { status: 201 });
    }
    if (url.includes("/generate-project-view")) {
      return new Response(
        JSON.stringify({
          render: {
            body: "tanren-fixture-easy: 1 run in flight, 1 PR review-ready; $42 spent this week.",
            attentionItems: [],
            prompts: ["What changed in the latest PR?"],
          },
        }),
        { status: 201 },
      );
    }
    if (url.endsWith("/forge/tools")) {
      toolCalls.push({ url, body });
      return new Response(JSON.stringify({ tool: body.tool, result: {} }), { status: 200 });
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
