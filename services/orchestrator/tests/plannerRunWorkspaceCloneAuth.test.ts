// Clone-auth coverage: the run's workspace clone must be able to authenticate a
// PRIVATE target repo, mirroring the push path. The token is fed to the clone
// over SSH stdin via the shared git credential helper — it must NEVER appear in
// the command string (process args / event log) or in the SSH stdin echoed into
// any event. Without a token the clone stays the plain public-repo path.
import { describe, expect, it } from "vitest";
import type { SshTarget } from "../src/engine/contracts/allocator.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import type { SshCommand, SshCommandResult, SshSubstrate } from "../src/engine/contracts/sshSubstrate.js";
import { storeGithubToken } from "../src/engine/credentials/githubToken.js";
import { prepareRunWorkspace } from "../src/engine/workflow/plannerRunWorkspace.js";
import type { PlannerRunContext, RunPlannerLoopInput } from "../src/engine/workflow/plannerRun.js";

const target: SshTarget = {
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};

// Captures every command (and its stdin) so the test can assert the token is
// only ever delivered over stdin. The clone's trailing `git rev-parse HEAD`
// must return a sha, so the recorder yields a fixed clone HEAD.
class RecordingSsh implements SshSubstrate {
  readonly commands: Array<{ target: SshTarget; command: SshCommand }> = [];

  async run(sshTarget: SshTarget, command: SshCommand): Promise<SshCommandResult> {
    this.commands.push({ target: sshTarget, command });
    return { exitCode: 0, stdout: CLONE_HEAD, stderr: "", timedOut: false };
  }
}

const CLONE_HEAD = "a".repeat(40);
const TOKEN = "ghp_secretClONEToken";

function makeContext(overrides: Partial<PlannerRunContext> = {}): PlannerRunContext {
  return {
    runId: "run_clone",
    specId: "spec_clone",
    projectId: "project_clone",
    repoUrl: "https://github.com/cat-cave/private-fixture",
    targetBranch: "main",
    runBranch: "tanren/run_clone",
    specTitle: "t",
    specDescription: "d",
    acceptanceCriteria: [],
    runnerImage: "image",
    identitySecretRef: "runner/test/identity",
    githubCredentialRef: "credential/github/dev",
    ...overrides,
  };
}

// A minimal prepareRunWorkspace input: the bootstrap/commit steps are injected
// no-ops so the unit run never touches a real git tree, and an explicit
// bootstrapCommand skips the SSH config read.
function makeInput(
  ssh: SshSubstrate,
  context: PlannerRunContext,
  opts: { githubToken?: string; secrets?: FakeSecretStore } = {},
): RunPlannerLoopInput {
  return {
    ssh,
    secrets: opts.secrets ?? new FakeSecretStore(),
    context,
    timeoutMs: 500,
    bootstrapCommand: "true",
    runBootstrap: async () => {},
    commitBootstrap: async () => "",
    ...(opts.githubToken === undefined ? {} : { githubToken: opts.githubToken }),
  } as unknown as RunPlannerLoopInput;
}

describe("prepareRunWorkspace clone authentication", () => {
  it("authenticates the clone via the stdin-fed credential helper (token not on the command line)", async () => {
    const ssh = new RecordingSsh();
    await prepareRunWorkspace(
      makeInput(ssh, makeContext(), { githubToken: TOKEN }),
      target,
      "/workspace/runs/run_clone/repo",
    );

    const clone = ssh.commands[0]?.command;
    expect(clone).toBeDefined();
    // The token is delivered ONLY over stdin.
    expect(clone?.stdin).toBe(TOKEN);
    // The credential helper is wired (GIT_ASKPASS + the x-access-token username).
    expect(clone?.command).toContain("GIT_ASKPASS");
    expect(clone?.command).toContain("x-access-token");
    // The token never appears in the command string (process args / event log),
    // raw or base64-encoded.
    expect(clone?.command).not.toContain(TOKEN);
    expect(clone?.command).not.toContain(Buffer.from(TOKEN, "utf8").toString("base64"));
    // It is a clone of the HTTPS remote on the requested branch.
    expect(clone?.command).toContain("git clone --depth 1 --branch 'main'");
    expect(clone?.command).toContain("https://github.com/cat-cave/private-fixture.git");
  });

  it("clones a private-style repo URL with auth and captures the clone HEAD", async () => {
    const ssh = new RecordingSsh();
    const prepared = await prepareRunWorkspace(
      makeInput(ssh, makeContext({ repoUrl: "https://github.com/acme/closed-source" }), { githubToken: TOKEN }),
      target,
      "/workspace/runs/run_clone/repo",
    );
    expect(prepared.cloneHeadSha).toBe(CLONE_HEAD);
    expect(ssh.commands[0]?.command.command).toContain("https://github.com/acme/closed-source.git");
    expect(ssh.commands[0]?.command.stdin).toBe(TOKEN);
  });

  it("leaves the public/no-credential path unauthenticated (no credential helper, no stdin)", async () => {
    const ssh = new RecordingSsh();
    // No injected token AND no configured credential ref → unauthenticated clone.
    await prepareRunWorkspace(
      makeInput(ssh, makeContext({ githubCredentialRef: "" })),
      target,
      "/workspace/runs/run_clone/repo",
    );

    const clone = ssh.commands[0]?.command;
    // No token threaded → plain clone of the repo URL as configured, no helper.
    expect(clone?.stdin).toBeUndefined();
    expect(clone?.command).not.toContain("GIT_ASKPASS");
    expect(clone?.command).not.toContain("x-access-token");
    expect(clone?.command).toContain(
      "git clone --depth 1 --branch 'main' 'https://github.com/cat-cave/private-fixture'",
    );
  });

  it("resolves the token from secrets + the run's credential ref (production path) and keeps it off the command line", async () => {
    const ssh = new RecordingSsh();
    const secrets = new FakeSecretStore();
    await storeGithubToken(secrets, { ref: "credential/github/dev", token: TOKEN });

    // No injected token: prepareRunWorkspace must resolve it from the secret
    // store at context.githubCredentialRef — the SAME seam push uses.
    await prepareRunWorkspace(makeInput(ssh, makeContext(), { secrets }), target, "/workspace/runs/run_clone/repo");

    const clone = ssh.commands[0]?.command;
    expect(clone?.stdin).toBe(TOKEN);
    expect(clone?.command).toContain("GIT_ASKPASS");
    expect(clone?.command).not.toContain(TOKEN);
  });
});
