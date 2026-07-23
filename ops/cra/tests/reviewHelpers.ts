import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { vi } from "vitest";
import { AuditAdapter, type IsolatedControlRunner } from "../src/auditAdapter.js";
import { AuditArtifactStore } from "../src/artifactStore.js";
import { EventLog } from "../src/eventLog.js";
import { OfficialReviewPoster } from "../src/officialReview.js";
import { resolveCraPaths, type CraPaths } from "../src/paths.js";
import type { CommandExecutor } from "../src/process.js";
import { SingletonLease } from "../src/singleton.js";
import { PrStateStore } from "../src/stateStore.js";
import { firstSha, testConfig } from "./helpers.js";

// The sandbox runner used for the supervisor's trusted verification command. Passing
// (exit 0) — the clean-PR case. Kept inline to avoid an extra module dependency.
const passingRunner: IsolatedControlRunner = {
  run: async () => ({ stdout: "ok", stderr: "", exitCode: 0 }),
};

export const reviewMarkerKey = { pr: 1240, headSha: firstSha, rubricVersion: "2026-07-22" };

export async function stateFixture(
  roots: string[],
): Promise<{ paths: CraPaths; lease: SingletonLease; stateStore: PrStateStore }> {
  const root = await mkdtemp(resolve(tmpdir(), "cra-review-"));
  roots.push(root);
  const paths = resolveCraPaths("cat-cave/tanren", { HOME: root, XDG_STATE_HOME: resolve(root, "state") });
  const lease = await SingletonLease.acquire(paths.lockFile);
  const stateStore = new PrStateStore(paths, lease);
  await stateStore.recover();
  return { paths, lease, stateStore };
}

export function ghReviewResponse(state: "APPROVED" | "CHANGES_REQUESTED"): CommandExecutor {
  return async () => ({ stdout: JSON.stringify({ id: 5001, commit_id: firstSha, state }), stderr: "", exitCode: 0 });
}

export function ghSpy(state: "APPROVED" | "CHANGES_REQUESTED") {
  return vi.fn<CommandExecutor>(ghReviewResponse(state));
}

export function reviewDeps(
  paths: CraPaths,
  lease: SingletonLease,
  ghExecutor: CommandExecutor,
  workerStdout: string,
  workerExit = 0,
) {
  const workerExecutor: CommandExecutor = async () => ({ stdout: workerStdout, stderr: "", exitCode: workerExit });
  return {
    config: testConfig(),
    actor: "trevor-workstation[bot]",
    adapter: new AuditAdapter(testConfig(), passingRunner, workerExecutor),
    poster: new OfficialReviewPoster(testConfig(), "token", ghExecutor),
    stateStore: new PrStateStore(paths, lease),
    artifactStore: new AuditArtifactStore(paths, lease),
    events: new EventLog(paths, lease),
  };
}
