// Proves the live-validation fix: the workspace bootstrap (e.g. `npm install`)
// creates install artifacts AFTER the clone, and those must not leak into the
// writer's captured diff nor into the branch pushed as the PR.
//
// The invariant (per the bug report): given a bootstrap that creates an
// UNTRACKED file X and a writer that changes a tracked file Y,
//   (a) the writer's captured diff (vs the post-bootstrap baseSha) shows only Y,
//   (b) the branch prepared for the PR contains only Y — X is absent.
//
// The runner runs git over SSH, so the helpers emit git command strings rather
// than touching a local repo (the architecture gate confines host process spawn
// to the cli-runner). We drive those strings through a ScriptedSsh that returns
// real `git`-shaped output, and assert BOTH the emitted git plumbing (so the
// rebase/commit semantics are exercised) AND the values the helpers return.
import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import { captureGitStateAfterCodex } from "../src/engine/providers/codexGit.js";
import {
  BOOTSTRAP_COMMIT_MESSAGE,
  commitBootstrapState,
  seedWorkspaceLocalIgnore,
} from "../src/engine/workspace/bootstrap.js";
import { PR_CLEAN_REF, prepareCleanPrBranch } from "../src/engine/workspace/githubPush.js";

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner",
  identitySecretRef: "runner/test/identity",
};

const CLONE_HEAD = "1".repeat(40);
const BOOTSTRAP_SHA = "2".repeat(40);
const WRITER_SHA = "3".repeat(40);

// Returns scripted stdout per command, keyed by a substring match, and records
// every command the helpers emit so the git plumbing can be asserted.
class ScriptedSsh implements CommandSubstrate {
  readonly commands: string[] = [];

  constructor(private readonly replies: Array<{ match: string; stdout: string }>) {}

  async run(_target: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command.command);
    const reply = this.replies.find((entry) => command.command.includes(entry.match));
    return { exitCode: 0, stdout: reply?.stdout ?? "", stderr: "", timedOut: false };
  }
}

const timeoutMs = 1_000;
const workspacePath = "/workspace/runs/run_x/repo";

describe("workspace local git ignore", () => {
  it("appends node_modules/ and dist/ to the checkout's .git/info/exclude (never a committed file)", async () => {
    // The durable node_modules guard: a per-checkout ignore so a later `git add -A`
    // (bootstrap commit / writer commit) never sweeps an install tree into the repo
    // — the 46MB checker-prompt failure mode. This must run AFTER clone, so it is a
    // workspace-local exclude rather than a committed `.gitignore`.
    const ssh = new ScriptedSsh([]);
    await seedWorkspaceLocalIgnore({ ssh, target, workspacePath, timeoutMs });

    expect(ssh.commands).toHaveLength(1);
    const cmd = ssh.commands[0] ?? "";
    // Resolves the worktree-correct exclude path and appends (>>) to it — never a
    // committed .gitignore.
    expect(cmd).toContain("git rev-parse --git-path info/exclude");
    expect(cmd).toContain(">>");
    expect(cmd).toContain("info/exclude");
    expect(cmd).not.toContain(".gitignore");
    // Both ignore paths are written.
    expect(cmd).toContain("node_modules/");
    expect(cmd).toContain("dist/");
  });
});

describe("bootstrap-artifact isolation", () => {
  it("commits the bootstrap state as the writer's diff base, off the writer's commit", async () => {
    // commitBootstrapState commits the bootstrap-generated tree (lockfiles,
    // node_modules) and returns the commit sha — this becomes the writer baseSha.
    const ssh = new ScriptedSsh([{ match: "git rev-parse HEAD", stdout: `${BOOTSTRAP_SHA}\n` }]);
    const bootstrapSha = await commitBootstrapState({ ssh, target, workspacePath, timeoutMs });

    expect(bootstrapSha).toBe(BOOTSTRAP_SHA);
    const cmd = ssh.commands[0] ?? "";
    // `git add -A` stages ALL bootstrap artifacts INTO the bootstrap commit, so
    // they land BELOW the writer's diff base (and never in the writer's diff).
    expect(cmd).toContain("git add -A");
    expect(cmd).toContain(`-m '${BOOTSTRAP_COMMIT_MESSAGE}'`);
    // --allow-empty so the no-manifest case still yields a concrete base sha.
    expect(cmd).toContain("--allow-empty");
    // -q so the commit summary stays off stdout; rev-parse is the sha source.
    expect(cmd).toContain("git commit -q");
  });

  it("(a) captures the writer diff against the post-bootstrap base", async () => {
    // The codex writer commits its change and diffs vs the baseSha it was given.
    // Pointing baseSha at the bootstrap commit means the diff is bootstrapSha..
    // worktree — only the writer's file, never the bootstrap artifacts below it.
    const ssh = new ScriptedSsh([
      { match: "git diff --no-color", stdout: "diff --git a/src/status.ts b/src/status.ts\n+ok()\n" },
      { match: "git log", stdout: `${WRITER_SHA}\twriter change\n` },
    ]);
    const state = await captureGitStateAfterCodex(ssh, target, workspacePath, BOOTSTRAP_SHA, timeoutMs);

    // The diff/log are taken relative to the bootstrap base, not the clone HEAD.
    const diffCmd = ssh.commands.find((c) => c.includes("git diff --no-color")) ?? "";
    const logCmd = ssh.commands.find((c) => c.includes("git log")) ?? "";
    expect(diffCmd).toContain(`git diff --no-color ${BOOTSTRAP_SHA}`);
    expect(logCmd).toContain(`${BOOTSTRAP_SHA}..HEAD`);
    expect(state.diff).toContain("src/status.ts");
    expect(state.diff).not.toContain("package-lock.json");
  });

  it("(b) prepares the PR branch by dropping the bootstrap commit, keeping the writer's", async () => {
    // prepareCleanPrBranch replays the writer commits (bootstrapSha..HEAD) onto
    // the clone HEAD into PR_CLEAN_REF, so the pushed branch carries only the
    // writer's changes — the bootstrap commit (and its artifacts) is dropped.
    const ssh = new ScriptedSsh([{ match: "git rev-parse HEAD", stdout: `${WRITER_SHA}\n` }]);
    const pushRef = await prepareCleanPrBranch({
      ssh,
      target,
      workspacePath,
      cloneHeadSha: CLONE_HEAD,
      bootstrapSha: BOOTSTRAP_SHA,
      timeoutMs,
    });

    expect(pushRef).toBe(PR_CLEAN_REF);
    const cmd = ssh.commands[0] ?? "";
    // Replay writer commits onto the clone HEAD, dropping the bootstrap commit.
    expect(cmd).toContain(`git rebase --onto '${CLONE_HEAD}' '${BOOTSTRAP_SHA}'`);
    // Capture the cleaned tip into the push ref, then restore the working HEAD
    // (so a review-rework re-entry keeps its bootstrapSha diff base intact).
    expect(cmd).toContain(`git update-ref '${PR_CLEAN_REF}' HEAD`);
    expect(cmd).toContain('git checkout --quiet --detach "$orig_head"');
  });

  it("(b) no-ops the PR-branch cleanup when there is no real bootstrap commit", async () => {
    // Fake-SSH unit paths yield empty shas (and the no-bootstrap case yields a
    // bootstrapSha equal to the clone HEAD) — nothing to drop, push the HEAD.
    const ssh = new ScriptedSsh([]);
    const empty = await prepareCleanPrBranch({
      ssh,
      target,
      workspacePath,
      cloneHeadSha: "",
      bootstrapSha: "",
      timeoutMs,
    });
    expect(empty).toBe("HEAD");

    const equal = await prepareCleanPrBranch({
      ssh,
      target,
      workspacePath,
      cloneHeadSha: CLONE_HEAD,
      bootstrapSha: CLONE_HEAD,
      timeoutMs,
    });
    expect(equal).toBe("HEAD");
    // No git ran in either no-op case.
    expect(ssh.commands).toHaveLength(0);
  });
});
