// #1059 (P1 data-loss) — the dependent PR-head publish (`pushJjHead`) must carry
// `--force-with-lease=refs/heads/<head>:<fetched-sha>`, NOT a blind `--force`. A seam test over
// a recording command substrate: assert the pushed command leases against the exact fetched sha
// (the anonymous + the authed path), and that a non-40-hex expected sha fails CLOSED (throws)
// rather than degrading to an effectively-blind lease.

import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { CommandResult, RunnerCommand } from "../src/engine/contracts/commandSubstrate.js";
import { FakeCommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { pushJjHead } from "../src/engine/workflow/reviewMerge/conflictResolver/jjAuthedPush.js";
import { forceWithLeaseArg, buildGitHubPushCommand } from "../src/engine/workspace/githubPush.js";

const HANDLE: RunnerHandle = { id: "runner_1", host: "localhost" } as unknown as RunnerHandle;
const FETCHED = "1111111111111111111111111111111111111111";

/** Records every command the push mechanism runs so the test reads the exact push refspec. */
class RecordingSubstrate extends FakeCommandSubstrate {
  readonly commands: string[] = [];
  override async run(handle: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command.command);
    return super.run(handle, command);
  }
}

describe("#1059 dependent-head publish carries --force-with-lease", () => {
  it("ANONYMOUS path: leases the push against the FETCHED sha, never a blind --force", async () => {
    const ssh = new RecordingSubstrate();
    // No installation + empty credential ref ⇒ the anonymous (tokenless) push path.
    await pushJjHead({
      ssh,
      target: HANDLE,
      workspacePath: "/ws",
      secrets: {} as never,
      orgId: "org_x",
      githubHttp: {} as never,
      repoUrl: "https://github.com/o/r",
      headBranch: "tanren/run_dep",
      expectedRemoteHeadSha: FETCHED,
      githubCredentialRef: "",
    });
    const push = ssh.commands.find((c) => c.includes("git push"));
    expect(push).toBeDefined();
    // The lease guards the EXACT branch:fetched-sha — a moved remote head rejects the push.
    expect(push).toContain(`--force-with-lease=refs/heads/tanren/run_dep:${FETCHED}`);
    // It is NOT a blind force (`--force` followed by the remote, with no lease).
    expect(push).not.toMatch(/--force\s+origin/u);
  });

  it("AUTHED path: leases the push against the FETCHED sha", async () => {
    const ssh = new RecordingSubstrate();
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: "credential/github/org/org_x/dev", value: "ghp_fake_static" });
    await pushJjHead({
      ssh,
      target: HANDLE,
      workspacePath: "/ws",
      secrets: secrets as never,
      orgId: "org_x",
      githubHttp: {} as never,
      repoUrl: "https://github.com/o/r",
      headBranch: "tanren/run_dep",
      expectedRemoteHeadSha: FETCHED,
      githubCredentialRef: "credential/github/org/org_x/dev",
    });
    const push = ssh.commands.find((c) => c.includes("git") && c.includes("push"));
    expect(push).toBeDefined();
    expect(push).toContain(`--force-with-lease=refs/heads/tanren/run_dep:${FETCHED}`);
  });

  it("FAIL-CLOSED: a non-40-hex expected sha throws (never a lease with a bogus/empty value)", () => {
    expect(() => forceWithLeaseArg("tanren/run_dep", "")).toThrow("force-with-lease");
    expect(() => forceWithLeaseArg("tanren/run_dep", "deadbeef")).toThrow("force-with-lease");
    // The shared builder honours the same lease (the initial PR push stays blind --force).
    const leased = buildGitHubPushCommand({
      repoUrl: "https://github.com/cat-cave/tanren-fixture-easy",
      branch: "tanren/run_dep",
      forceWithLease: { expectedSha: FETCHED },
    });
    expect(leased).toContain(`--force-with-lease=refs/heads/tanren/run_dep:${FETCHED}`);
  });
});
