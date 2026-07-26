import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import { parseGitHubRepository } from "../src/engine/providers/github.js";
import {
  buildGitHubPushCommand,
  PR_CLEAN_REF,
  pushWorkspaceBranchToGitHub,
} from "../src/engine/workspace/githubPush.js";
import { RecordingSsh } from "./helpers/githubDraftPrFakes.js";

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};

describe("GitHub workspace push lease contract", () => {
  it("requires a lease and never reaches SSH when it is absent", async () => {
    const ssh = new RecordingSsh();
    await pushWorkspaceBranchToGitHub({
      ssh,
      target,
      workspacePath: "/workspace/runs/run_123/repo",
      repoUrl: "https://github.com/cat-cave/tanren-fixture-easy",
      branch: "tanren/run_123",
      token: "ghp_secretToken",
      forceWithLease: { expectedAbsent: true },
    });
    expect(ssh.commands[0]?.command.command).toContain("GIT_ASKPASS");
    expect(ssh.commands[0]?.command.command).not.toContain("ghp_secretToken");

    await expect(
      pushWorkspaceBranchToGitHub({
        ssh,
        target,
        workspacePath: "/workspace/runs/run_123/repo",
        repoUrl: "https://github.com/cat-cave/tanren-fixture-easy",
        branch: "tanren/run_123",
        token: "ghp_secretToken",
      } as never),
    ).rejects.toThrow("explicit remote-state lease");
    expect(ssh.commands).toHaveLength(1);
  });

  it("uses explicit leases, never a blind force, and rejects runtime omission", () => {
    expect(parseGitHubRepository("git@github.com:cat-cave/tanren-fixture-easy.git")).toEqual({
      owner: "cat-cave",
      name: "tanren-fixture-easy",
    });
    const head = buildGitHubPushCommand({
      repoUrl: "https://github.com/cat-cave/tanren-fixture-easy",
      branch: "tanren/run_123",
      forceWithLease: { expectedAbsent: true },
    });
    expect(head).toContain("HEAD:refs/heads/tanren/run_123");
    const clean = buildGitHubPushCommand({
      repoUrl: "https://github.com/cat-cave/tanren-fixture-easy",
      branch: "tanren/run_123",
      sourceRef: PR_CLEAN_REF,
      forceWithLease: { expectedAbsent: true },
    });
    expect(clean).toContain(`${PR_CLEAN_REF}:refs/heads/tanren/run_123`);
    expect(clean).toContain("--force-with-lease=refs/heads/tanren/run_123:");
    expect(clean).not.toMatch(/(?:^|\s)--force(?:\s|$)/u);
    expect(() =>
      buildGitHubPushCommand({
        repoUrl: "https://github.com/cat-cave/tanren-fixture-easy",
        branch: "tanren/run_123",
      } as never),
    ).toThrow("explicit remote-state lease");
  });
});
