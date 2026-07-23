import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditArtifactStore } from "../src/artifactStore.js";
import { EventLog } from "../src/eventLog.js";
import { EventLogMergeRecorder } from "../src/mergeRecorder.js";
import { resolveCraPaths } from "../src/paths.js";
import { SingletonLease } from "../src/singleton.js";
import { PrStateStore } from "../src/stateStore.js";
import type { CraEvent, PrState } from "../src/stateSchemas.js";
import { firstSha, secondSha } from "./helpers.js";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
});

async function stateFixture() {
  const root = await mkdtemp(resolve(tmpdir(), "cra-state-"));
  roots.push(root);
  const paths = resolveCraPaths("cat-cave/tanren", { HOME: root, XDG_STATE_HOME: resolve(root, "state") });
  return { root, paths };
}

function prState(): PrState {
  return {
    pr: 1240,
    lastSeenHeadSha: firstSha,
    lastReviewedHeadSha: firstSha,
    lastReviewedBaseSha: secondSha,
    auditedIssueNumber: 1247,
    rubricVersion: "2026-07-22",
    reviewId: 99,
    findingIds: ["finding-one"],
    disposition: "approved",
    firstAuthorActivityAt: "2026-07-20T00:00:00.000Z",
    lastAuthorActivityAt: "2026-07-21T00:00:00.000Z",
    awaitingAuthorSince: null,
    retry: { attempts: 0, nextAttemptAt: null, lastError: null },
    followUpIssues: [1300],
    reminderDaysSent: [],
    abandonmentReason: null,
    auditStatus: "completed",
    lastCompletedMode: null,
    reviewFindings: [],
  };
}

function event(detail: Record<string, unknown> = {}): CraEvent {
  return {
    timestamp: "2026-07-22T12:00:00.000Z",
    type: "poll",
    pr: null,
    headSha: null,
    rubricVersion: "2026-07-22",
    actor: "trevor-workstation[bot]",
    durationMs: 1,
    correlationId: "test-poll",
    detail,
  };
}

describe("persistent CRA state", () => {
  it("refuses a second process-wide flock holder", async () => {
    const { paths } = await stateFixture();
    const first = await SingletonLease.acquire(paths.lockFile);
    expect(first.isHeld()).toBe(true);
    await expect(SingletonLease.acquire(paths.lockFile)).rejects.toThrow("another CRA instance");
    await first.release();
    const next = await SingletonLease.acquire(paths.lockFile);
    await next.release();
  });

  it("discards an interrupted sibling write and preserves the committed record", async () => {
    const { paths } = await stateFixture();
    const lease = await SingletonLease.acquire(paths.lockFile);
    const store = new PrStateStore(paths, lease);
    await store.recover();
    await store.write(prState());
    await writeFile(resolve(paths.prsDirectory, ".1240.json.tmp-99999"), '{"partial":');
    await store.recover();
    expect(await store.read(1240)).toEqual(prState());
    expect((await stat(resolve(paths.prsDirectory, "1240.json"))).mode & 0o077).toBe(0);
    await lease.release();
    await expect(store.write({ ...prState(), disposition: "merged" })).rejects.toThrow("lease is not held");
  });

  it("makes reports immutable per PR, head, and rubric", async () => {
    const { paths } = await stateFixture();
    const lease = await SingletonLease.acquire(paths.lockFile);
    const store = new PrStateStore(paths, lease);
    await store.recover();
    const artifacts = new AuditArtifactStore(paths, lease);
    const artifact = {
      pr: 1240,
      headSha: firstSha,
      baseSha: secondSha,
      auditedIssueNumber: 1247,
      rubricVersion: "2026-07-22",
      createdAt: "2026-07-22T12:00:00.000Z",
      report: { findings: [] },
    };
    await artifacts.writeReport(artifact);
    await artifacts.writeReport(artifact);
    await expect(artifacts.writeReport({ ...artifact, report: { findings: ["different"] } })).rejects.toThrow(
      "immutable",
    );
    await expect(artifacts.writeReport({ ...artifact, rubricVersion: ".." })).rejects.toThrow("invalid rubric version");
    await artifacts.writeReport({ ...artifact, rubricVersion: "2026-08-01", report: { findings: ["new-rubric"] } });
    await lease.release();
  });

  it("truncates a crash-torn final JSONL record before appending", async () => {
    const { paths } = await stateFixture();
    const lease = await SingletonLease.acquire(paths.lockFile);
    const store = new PrStateStore(paths, lease);
    await store.recover();
    const log = new EventLog(paths, lease);
    await log.append(event({ sequence: 1 }));
    const path = resolve(paths.eventsDirectory, "2026-07-22.jsonl");
    await writeFile(path, `${await readFile(path, "utf8")}{"timestamp":`);
    await log.append(event({ sequence: 2 }));
    const lines = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[1].detail).toEqual({ sequence: 2 });
    await lease.release();
  });

  it("persists merge security anomalies in the durable event log", async () => {
    const { paths } = await stateFixture();
    const lease = await SingletonLease.acquire(paths.lockFile);
    const recorder = new EventLogMergeRecorder(
      new EventLog(paths, lease),
      {
        pr: 1240,
        headSha: firstSha,
        rubricVersion: "2026-07-22",
        actor: "trevor-workstation[bot]",
        correlationId: "merge-race",
      },
      () => "2026-07-22T12:00:00.000Z",
    );
    await recorder.recordSecurityAnomaly({
      pr: 1240,
      headSha: firstSha,
      mergeCommitSha: secondSha,
      auditedIssueNumber: 100,
      observedClosedIssues: [999],
      reopenedIssues: [999],
      auditedIssueClosed: true,
      reasons: ["body swap won the issue-closing race"],
    });
    const line = await readFile(resolve(paths.eventsDirectory, "2026-07-22.jsonl"), "utf8");
    expect(JSON.parse(line)).toMatchObject({
      type: "security_anomaly",
      detail: {
        severity: "SECURITY ANOMALY",
        observedClosedIssues: [999],
        reopenedIssues: [999],
      },
    });
    await lease.release();
  });
});
