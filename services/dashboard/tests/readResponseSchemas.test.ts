import { describe, expect, it } from "vitest";
import {
  FeedListResponseSchema,
  InsightListResponseSchema,
  MilestoneListResponseSchema,
  RunDetailReadSchema,
  RunListResponseSchema,
  SpecListResponseSchema,
} from "../src/api/readResponseSchemas.js";
import { RUN_DETAIL } from "./runDetail.render.fixtures.js";

const runItem = {
  ...RUN_DETAIL.run,
  specTitle: RUN_DETAIL.spec.title,
  costTotalUsd: "0.024",
  lastEventAt: new Date().toISOString(),
  needsReview: true,
};

const spec = {
  specId: "spec_x",
  projectId: "project_x",
  title: "Build it",
  description: "Build the complete behavior",
  acceptanceCriteria: ["it works"],
  dependsOn: [],
  status: "open",
};

const milestone = {
  id: "milestone_x",
  projectId: "project_x",
  label: "M1",
  name: "First milestone",
  description: null,
  orderIndex: 0,
  eta: null,
  status: "planned",
};

const insight = {
  id: "ins_x",
  kind: "retry_hotspot",
  projectId: "project_x",
  severity: "warn",
  title: "writer retries",
  body: "4 retries in 7 days",
  payload: { kind: "retry_hotspot", specId: "spec_a" },
  actions: [{ label: "switch writer", toolCall: { tool: "tanren.create_spec", args: {} } }],
  computedAt: "2026-05-28T08:00:00.000Z",
  acknowledgedAt: null,
};

const feedItem = {
  eventType: "task.write.started",
  id: 10,
  payload: { kind: "task.write.started" },
  projectId: "project_x",
  redactedPaths: [],
  runId: "run_a",
  specId: "spec_a",
  taskId: "task_1",
  ts: "2026-05-28T10:05:00.000Z",
};

describe("dashboard read-response runtime authorities", () => {
  it("accepts complete run, spec, milestone, insight, feed, and run-detail payloads", () => {
    expect(RunListResponseSchema.safeParse({ items: [runItem] }).success).toBe(true);
    expect(SpecListResponseSchema.safeParse({ specs: [spec] }).success).toBe(true);
    expect(MilestoneListResponseSchema.safeParse({ milestones: [milestone] }).success).toBe(true);
    expect(InsightListResponseSchema.safeParse({ insights: [insight] }).success).toBe(true);
    expect(FeedListResponseSchema.safeParse({ items: [feedItem] }).success).toBe(true);
    expect(RunDetailReadSchema.safeParse(RUN_DETAIL).success).toBe(true);
  });

  it.each([
    ["run item", RunListResponseSchema, { items: [{ ...runItem, needsReview: undefined }] }],
    ["spec row", SpecListResponseSchema, { specs: [{ ...spec, acceptanceCriteria: undefined }] }],
    ["milestone row", MilestoneListResponseSchema, { milestones: [{ ...milestone, orderIndex: undefined }] }],
    ["insight row", InsightListResponseSchema, { insights: [{ ...insight, severity: undefined }] }],
    ["feed row", FeedListResponseSchema, { items: [{ ...feedItem, runId: undefined }] }],
    ["run-detail task", RunDetailReadSchema, { ...RUN_DETAIL, tasks: [{ ...RUN_DETAIL.tasks[0]!, model: undefined }] }],
    [
      "run-detail event",
      RunDetailReadSchema,
      { ...RUN_DETAIL, recentEvents: [{ ...RUN_DETAIL.recentEvents[0]!, redactedPaths: undefined }] },
    ],
    [
      "run-detail cost",
      RunDetailReadSchema,
      { ...RUN_DETAIL, costs: [{ ...RUN_DETAIL.costs[0]!, costBasis: undefined }] },
    ],
  ])("rejects an incomplete %s instead of laundering it into success", (_name, schema, body) => {
    expect(schema.safeParse(body).success).toBe(false);
  });

  it("rejects unknown response fields at every top-level boundary", () => {
    expect(RunListResponseSchema.safeParse({ items: [runItem], legacyItems: [] }).success).toBe(false);
    expect(SpecListResponseSchema.safeParse({ specs: [spec], status: "ok" }).success).toBe(false);
    expect(MilestoneListResponseSchema.safeParse({ milestones: [milestone], next: null }).success).toBe(false);
    expect(InsightListResponseSchema.safeParse({ insights: [insight], extra: 1 }).success).toBe(false);
    expect(FeedListResponseSchema.safeParse({ items: [feedItem], meta: {} }).success).toBe(false);
    expect(RunDetailReadSchema.safeParse({ ...RUN_DETAIL, legacyTasks: [] }).success).toBe(false);
  });
});
