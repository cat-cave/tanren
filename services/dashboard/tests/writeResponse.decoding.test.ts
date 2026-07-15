import { describe, expect, it } from "vitest";
import { AuditsClient } from "../src/api/auditsClient.js";
import { DiscoveryClient } from "../src/api/discoveryClient.js";
import { OrchestratorClient } from "../src/api/orchestrator.js";
import {
  CreatedProjectSchema,
  DeriveResultSchema,
  DiscoveryAcceptSchema,
  ForgeAskResponseSchema,
  ForgeDecisionResponseSchema,
  ForgeRenderResponseSchema,
  ForgeThreadIdResponseSchema,
  InterviewRoundSchema,
  QueuedRunResponseSchema,
  SpecSummarySchema,
} from "../src/api/writeResponseSchemas.js";

const malformedBodies: unknown[] = [{}, [], { job: {} }, { proposals: "not-an-array" }];
const projectWire = {
  projectId: "project_1",
  orgId: "org_1",
  name: "Tanren",
  repoUrl: "https://github.com/cat-cave/tanren",
  defaultBranch: "main",
  runnerImage: "runner:latest",
  allocator: "local-docker",
  config: { version: 1, governancePosture: "strict" },
};
const specWire = {
  specId: "spec_1",
  projectId: "project_1",
  orgId: "org_1",
  title: "Close the loop",
  description: "A real spec",
  acceptanceCriteria: ["green"],
  dependsOn: [],
  status: "open",
  priority: "P0",
  mode: "from_scratch",
};
const forgeAnswerWire = {
  body: "The run is healthy.",
  attentionItems: [{ priority: "info", title: "Healthy", sub: "No action", action: null }],
  insights: [],
  prompts: ["Show costs"],
  proposedActions: null,
};
const forgeTurnWire = {
  id: "turn_1",
  threadId: "thread_1",
  index: 1,
  source: { kind: "operator", userId: "user_1" },
  audience: "project:member",
  authorKind: "forge_llm",
  render: forgeAnswerWire,
  createdAt: "2026-07-14T12:00:00.000Z",
};
const forgeThreadWire = {
  id: "thread_1",
  orgId: "org_1",
  projectId: "project_1",
  runId: null,
  scope: "project",
  title: null,
  createdAt: "2026-07-14T12:00:00.000Z",
  updatedAt: "2026-07-14T12:00:00.000Z",
  closedAt: null,
};
const forgeProposalWire = {
  id: "proposal_1",
  orgId: "org_1",
  threadId: "thread_1",
  proposingTurnId: "turn_1",
  toolName: "tanren.trigger_run",
  args: { specId: "spec_1" },
  rationale: "Run it",
  status: "pending",
  proposedAt: "2026-07-14T12:00:00.000Z",
  decidedBy: null,
  decidedAt: null,
  result: null,
  error: null,
};

describe("typed write response decoders", () => {
  it("validates rich canonical create/trigger responses before projecting the dashboard subset", () => {
    expect(CreatedProjectSchema.parse(projectWire)).toEqual({
      projectId: "project_1",
      name: "Tanren",
      repoUrl: "https://github.com/cat-cave/tanren",
      defaultBranch: "main",
      runnerImage: "runner:latest",
      allocator: "local-docker",
    });
    expect(SpecSummarySchema.parse(specWire)).toMatchObject({ specId: "spec_1", status: "open" });
    expect(
      QueuedRunResponseSchema.parse({
        runId: "run_1",
        specId: "spec_1",
        projectId: "project_1",
        orgId: "org_1",
        trigger: "dashboard",
        branch: "tanren/spec-1",
        status: "queued",
        plannerTaskId: "task_plan",
        plannerJobId: "job_plan",
        project: projectWire,
        spec: specWire,
      }),
    ).toEqual({ runId: "run_1" });
  });

  it("validates full Forge rows and keeps nullable wire fields out of the dashboard view", () => {
    expect(ForgeThreadIdResponseSchema.parse(forgeThreadWire)).toEqual({ id: "thread_1" });
    expect(ForgeRenderResponseSchema.parse(forgeTurnWire)).toMatchObject({
      render: { body: "The run is healthy.", attentionItems: [{ title: "Healthy" }] },
    });
    expect(
      ForgeAskResponseSchema.parse({
        operatorTurn: { ...forgeTurnWire, id: "turn_0", index: 0, authorKind: "operator" },
        forgeTurn: forgeTurnWire,
        toolsUsed: ["tanren.read_run"],
        proposals: [forgeProposalWire],
      }),
    ).toMatchObject({ forgeTurn: { render: { body: "The run is healthy." } }, toolsUsed: ["tanren.read_run"] });
    expect(
      ForgeDecisionResponseSchema.parse({
        proposal: { ...forgeProposalWire, status: "rejected" },
        turn: forgeTurnWire,
      }),
    ).toMatchObject({ proposal: { status: "rejected" } });
  });

  it("accepts rich discovery and onboarding responses while returning their owned view", () => {
    expect(DiscoveryAcceptSchema.parse({ accepted: [{ proposalId: "proposal_1", spec: specWire }] })).toEqual({
      accepted: [
        {
          proposalId: "proposal_1",
          spec: { specId: "spec_1", projectId: "project_1", title: "Close the loop", status: "open" },
        },
      ],
    });
    expect(
      InterviewRoundSchema.parse({
        round: 1,
        totalRounds: 6,
        say: "What should we build?",
        suggestions: [],
        capture: {
          identity: null,
          personas: [],
          behaviors: [],
          interfaces: [],
          designContract: null,
          architecture: [],
          lifecycle: {
            stack: "TypeScript",
            bootstrap: "just bootstrap",
            tier1: "just tier-1",
            tier2: "just tier-2",
            tier3: "just tier-3",
            build: "just build",
            deploy: "just deploy",
            upgrade: "pnpm update --latest",
            toolchain: [{ name: "node", version: "24" }],
          },
          lifecycleConfirmed: false,
          rulesets: [],
        },
        complete: false,
      }),
    ).toMatchObject({ capture: { lifecycleConfirmed: false } });
    expect(
      DeriveResultSchema.parse({
        projectId: "project_1",
        projectName: "Tanren",
        repository: {
          fullName: "cat-cave/tanren",
          repoUrl: "https://github.com/cat-cave/tanren",
          defaultBranch: "main",
        },
        specIds: ["spec_1"],
        personaIds: ["persona_1"],
        behaviorIds: ["behavior_1"],
        milestoneIds: ["milestone_1"],
        designContractId: "design_1",
        templateSeed: { templateRef: "tanren://composed/app@abc", validatedAt: "2026-07-14T12:00:00.000Z" },
        inboxSource: { id: "inbox_1", created: true },
        bootstrap: {
          inboxSource: { id: "inbox_1", created: true },
          notificationRoute: { targetId: "target_1", created: true, events: 4 },
          auditCatalog: { jobs: 4, created: ["security"] },
          errors: [],
        },
      }),
    ).toEqual({
      projectId: "project_1",
      projectName: "Tanren",
      specIds: ["spec_1"],
      personaIds: ["persona_1"],
      behaviorIds: ["behavior_1"],
      milestoneIds: ["milestone_1"],
    });
  });

  it.each(malformedBodies)("AuditsClient.create rejects malformed successful body %#", async (body) => {
    const client = new AuditsClient({
      orchestratorUrl: "http://orch",
      fetchImpl: async () => new Response(JSON.stringify(body), { status: 200 }),
    });
    const result = await client.create("org_1", {
      kind: "security",
      name: "security",
      cadence: "nightly",
      projectId: null,
      targetWindow: "02:00",
      answererCli: "grok",
    });
    expect(result).toEqual({ ok: false });
  });

  it.each(malformedBodies)("DiscoveryClient.classify rejects malformed successful body %#", async (body) => {
    const client = new DiscoveryClient({
      orchestratorUrl: "http://orch",
      fetchImpl: async () => new Response(JSON.stringify(body), { status: 200 }),
    });
    const result = await client.classify("org_1", "project_1", {
      variant: "bug",
      source: "operator",
      sourceLabel: "operator",
      who: "operator",
      when: "now",
      glyph: "!",
      body: "broken",
    });
    expect(result).toEqual({ ok: false, status: 200, result: undefined });
  });

  it.each([{}, [], { run: null }, { run: { runId: "run_1" } }])(
    "getRunDetail rejects malformed 200 body %#",
    async (body) => {
      const client = new OrchestratorClient({
        orchestratorUrl: "http://orch",
        fetchImpl: async () => new Response(JSON.stringify(body), { status: 200 }),
      });
      await expect(client.getRunDetail({ orgId: "org_1", projectId: "project_1" }, "run_1")).resolves.toBeUndefined();
    },
  );
});
