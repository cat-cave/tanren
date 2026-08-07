/* Negative controls for design-oracle failures discovered before answerer entry. */
/* eslint-disable unicorn/no-thenable */
import { describe, expect, it } from "vitest";
import type pg from "pg";
import type { ActorContext } from "../src/auth/schemas.js";
import type { EventName, EventPayload } from "../src/engine/events/index.js";
import { parseDesignContract } from "../src/engine/design/designContract.js";
import type { DesignOracleAnswer } from "../src/engine/answerers/schemas/index.js";
import type { AnswererAdapter } from "../src/engine/providers/types.js";
import { runDesignOracleLoopStage } from "../src/engine/workflow/designOracleLoopStage.js";
import type { SubtaskCostContext } from "../src/engine/workflow/subtaskCost.js";
import { InMemoryRunStateWriter } from "./fixtures/inMemoryRunStateWriter.js";

const ORG = "org_design_oracle";
const PROJECT = "project_design_oracle";
const contract = parseDesignContract({
  version: 1,
  domain: "saas-web",
  identity: "calm console",
  intent: "clear work",
  principles: [],
  constraints: [],
  personaRefs: ["persona_admin"],
  behaviorRefs: ["behavior_invite"],
  dimensions: [],
});

type State = "found" | "absent" | "corrupt" | "unresolved";

class FakeClient implements Pick<pg.Pool, "query"> {
  constructor(private readonly state: State) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async query(sql: unknown, params: ReadonlyArray<unknown> = []): Promise<any> {
    const text = String(sql);
    if (text.includes("FROM design_contracts")) {
      if (this.state === "absent") return { rows: [], rowCount: 0 };
      return {
        rows: [
          {
            id: "design_1",
            org_id: ORG,
            project_id: PROJECT,
            version: 1,
            domain: contract.domain,
            contract: this.state === "corrupt" ? { broken: true } : contract,
          },
        ],
        rowCount: 1,
      };
    }
    if (text.includes("FROM personas")) {
      if (this.state === "unresolved" || params[0] !== "persona_admin") return { rows: [], rowCount: 0 };
      return {
        rows: [
          {
            id: "persona_admin",
            scope: "org",
            org_id: ORG,
            project_id: null,
            name: "Admin",
            description: "runs the org",
            metadata: {},
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
        rowCount: 1,
      };
    }
    if (text.includes("FROM behaviors")) {
      return {
        rows:
          this.state === "unresolved"
            ? []
            : [
                {
                  id: "behavior_invite",
                  persona_id: "persona_admin",
                  title: "Invite",
                  given: "g",
                  when: "w",
                  then: "t",
                  description: null,
                  metadata: {},
                  created_at: new Date(),
                  updated_at: new Date(),
                },
              ],
        rowCount: this.state === "unresolved" ? 0 : 1,
      };
    }
    return { rows: [], rowCount: 0 };
  }
}

interface Harness {
  events: Array<{ eventType: EventName; taskId?: string; payload: Record<string, unknown> }>;
  tasks: InMemoryRunStateWriter["tasks"];
  answererCalls: () => number;
  costs: () => number;
  run: () => Promise<unknown>;
}

function harness(state: State, nullOrg = false): Harness {
  const client = new FakeClient(state);
  const events: Harness["events"] = [];
  const writer = new InMemoryRunStateWriter({
    forwardAppend: async (input) => {
      events.push({
        eventType: input.eventType as EventName,
        taskId: input.taskId,
        payload: input.payload as Record<string, unknown>,
      });
    },
  });
  let answererCalls = 0;
  let costs = 0;
  const adapter: AnswererAdapter<DesignOracleAnswer> = {
    kind: "answerer",
    cli: "fake",
    authRef: "fake",
    async runAnswerer(input) {
      answererCalls += 1;
      return input.outputSchema.parse({ verificationMode: "static", findings: [], summary: "checked" });
    },
  };
  const actor: ActorContext = {
    userId: "user_1",
    orgId: nullOrg ? null : ORG,
    projectId: PROJECT,
    scopes: [],
    source: "session",
  };
  const appendEvent = async <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => {
    events.push({ eventType, taskId, payload: payload as Record<string, unknown> });
  };
  const costCtx: SubtaskCostContext = {
    recorder: { record: async () => void (costs += 1) } as never,
    runId: "run_1",
    specId: "spec_1",
    projectId: PROJECT,
    orgId: ORG,
  };
  return {
    events,
    tasks: writer.tasks,
    answererCalls: () => answererCalls,
    costs: () => costs,
    run: () =>
      runDesignOracleLoopStage({
        pool: client,
        writer,
        costCtx,
        adapter,
        client,
        projectId: PROJECT,
        actor,
        actorRef: { kind: "operator" },
        runId: "run_1",
        workspacePath: "/ws",
        plannerTaskId: "task_plan",
        baselineSha: "a".repeat(40),
        appendEvent,
      }),
  };
}

async function expectOneFailedTask(h: Harness, failureKind: string): Promise<void> {
  await expect(h.run()).rejects.toBeDefined();
  const failed = h.events.filter((event) => event.eventType === "task.failed");
  expect(failed).toHaveLength(1);
  expect(failed[0]?.payload).toMatchObject({ taskKind: "designOracle", failureKind });
  expect(h.events.filter((event) => event.eventType === "task.completed")).toHaveLength(0);
  expect(h.tasks.size).toBe(1);
  expect(h.answererCalls()).toBe(0);
  expect(h.costs()).toBe(0);
}

describe("design-oracle pre-answerer lifecycle", () => {
  it("materializes one failed task/event for a null-org actor", async () => {
    await expectOneFailedTask(harness("found", true), "design_oracle_actor_config");
  });

  it("materializes one failed task/event for a corrupt contract", async () => {
    await expectOneFailedTask(harness("corrupt"), "design_contract_corrupt");
  });

  it("materializes one failed task/event for an unresolved reference", async () => {
    await expectOneFailedTask(harness("unresolved"), "crashed");
  });

  it("keeps the intentional absent-contract path without a task", async () => {
    const h = harness("absent");
    await expect(h.run()).resolves.toEqual({ findings: [], designOracleTaskId: undefined });
    expect(h.events).toEqual([]);
    expect(h.tasks.size).toBe(0);
    expect(h.answererCalls()).toBe(0);
    expect(h.costs()).toBe(0);
  });
});
