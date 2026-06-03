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
import type { OrgGithubAppInstallation } from "../src/engine/config/orgConfig.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../src/engine/providers/github.js";
import { prepareRunWorkspace } from "../src/engine/workflow/plannerRunWorkspace.js";
import type { PlannerRunContext, RunPlannerLoopInput } from "../src/engine/workflow/plannerRun.js";
import { vcsProviderOver } from "./helpers/vcsProvider.js";
import type { VcsCredentialContext } from "../src/engine/contracts/vcsProvider.js";

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
const APP_TOKEN = "ghs_appInstallationToken";

// A GitHub HTTP client for the clone-auth path. The only legitimate GitHub call
// the AUTHENTICATED clone makes is MERGE-SAFETY's `resolveActorIdentity` static
// `GET /user` (so the runner's git author attributes to a real login) — served
// here with a fixed Tanren login/id. Every OTHER path must stay off HTTP (the
// token resolution reads the secret store), so anything else throws loudly.
const CLONE_ACTOR_LOGIN = "tanren-clone-bot";
const CLONE_ACTOR_ID = 700700;
function unusedHttp(): GitHubHttpClient {
  return {
    request: async (req: GitHubHttpRequest): Promise<GitHubHttpResponse> => {
      if (req.method === "GET" && (req.path === "/user" || req.path.startsWith("/user?"))) {
        return { status: 200, body: { login: CLONE_ACTOR_LOGIN, id: CLONE_ACTOR_ID } };
      }
      throw new Error(`clone-auth must not issue GitHub HTTP: ${req.method} ${req.path}`);
    },
  };
}

const installation: OrgGithubAppInstallation = {
  appId: "12345",
  installationId: "67890",
  credentialRef: "credential/github_app/test",
  installedAt: "2026-01-01T00:00:00Z",
};

/**
 * A VcsProvider that delegates everything to the REAL GitHubVcsProvider but
 * RECORDS the credential context each `resolveToken` receives and, when an App
 * installation is present, short-circuits to a fixed installation token (so the
 * App-first path is observable without standing up a real App-token minter).
 * This proves the clone routes through the seam App-first.
 */
function recordingProvider(): { provider: ReturnType<typeof vcsProviderOver>; calls: VcsCredentialContext[] } {
  const real = vcsProviderOver(unusedHttp());
  const calls: VcsCredentialContext[] = [];
  const provider = new Proxy(real, {
    get(inner, prop, receiver) {
      if (prop === "resolveToken") {
        return async (creds: VcsCredentialContext) => {
          calls.push(creds);
          if (creds.installation !== undefined) {
            // MERGE-SAFETY: the App-first short-circuit also carries an identity
            // supplier (the App bot login) so resolveActorIdentity resolves the
            // git author without standing up a real App-token minter.
            return {
              token: APP_TOKEN,
              source: "github_app" as const,
              refresh: async () => APP_TOKEN,
              identity: async () => ({
                login: "tanren-app[bot]",
                id: "12345",
                noreplyEmail: "12345+tanren-app[bot]@users.noreply.github.com",
              }),
            };
          }
          return inner.resolveToken(creds);
        };
      }
      return Reflect.get(inner, prop, receiver);
    },
  });
  return { provider, calls };
}

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
  opts: {
    githubToken?: string;
    secrets?: FakeSecretStore;
    vcsProvider?: ReturnType<typeof vcsProviderOver>;
  } = {},
): RunPlannerLoopInput {
  return {
    ssh,
    secrets: opts.secrets ?? new FakeSecretStore(),
    vcsProvider: opts.vcsProvider ?? vcsProviderOver(unusedHttp()),
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
    // MERGE-SAFETY (self-identity) end-to-end: the RESOLVED identity (from the
    // clone token's GET /user) lands in the workspace git config, so every writer/
    // rebase commit is attributable to the real login — NOT `planner@tanren.invalid`.
    expect(clone?.command).toContain(`git config user.name '${CLONE_ACTOR_LOGIN}'`);
    expect(clone?.command).toContain(
      `git config user.email '${CLONE_ACTOR_ID}+${CLONE_ACTOR_LOGIN}@users.noreply.github.com'`,
    );
    expect(clone?.command).not.toContain("planner@tanren.invalid");
  });

  it("P2a Part 2: clone resolves APP-FIRST through the VcsProvider seam when an App is installed", async () => {
    const ssh = new RecordingSsh();
    const { provider, calls } = recordingProvider();
    // Both an App installation AND a static ref are present: App-first wins.
    await prepareRunWorkspace(
      makeInput(ssh, makeContext({ installation }), { vcsProvider: provider }),
      target,
      "/workspace/runs/run_clone/repo",
    );

    // The clone resolved through the seam carrying the installation (App-first),
    // and used the minted installation token over stdin — not the static ref.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.installation).toEqual(installation);
    const clone = ssh.commands[0]?.command;
    expect(clone?.stdin).toBe(APP_TOKEN);
    expect(clone?.command).toContain("GIT_ASKPASS");
    expect(clone?.command).not.toContain(APP_TOKEN);
  });

  it("MERGE-SAFETY: an authenticated run THROWS (no silent .invalid fallback) when identity resolution fails", async () => {
    const ssh = new RecordingSsh();
    const secrets = new FakeSecretStore();
    await storeGithubToken(secrets, { ref: "credential/github/dev", token: TOKEN });
    // A provider whose token resolves but whose actor-identity resolution FAILS
    // (e.g. GitHub returns a 5xx on GET /user). The run is authenticated (a static
    // credential ref is present), so this MUST be a loud throw — never a degrade to
    // the unattributable `planner@tanren.invalid` author.
    const real = vcsProviderOver(unusedHttp());
    const failingProvider = new Proxy(real, {
      get(inner, prop, receiver) {
        if (prop === "resolveActorIdentity") {
          return async () => {
            throw new Error("GitHub token identity read (GET /user) failed: HTTP 503");
          };
        }
        return Reflect.get(inner, prop, receiver);
      },
    });

    await expect(
      prepareRunWorkspace(
        makeInput(ssh, makeContext(), { secrets, vcsProvider: failingProvider }),
        target,
        "/workspace/runs/run_clone/repo",
      ),
    ).rejects.toThrow(/identity read/u);
    // The clone never ran — the run aborts before pushing as an unattributable author.
    expect(ssh.commands).toHaveLength(0);
  });

  it("P2a Part 2: clone routes through the seam (no installation) carrying the static ref only", async () => {
    const ssh = new RecordingSsh();
    const secrets = new FakeSecretStore();
    await storeGithubToken(secrets, { ref: "credential/github/dev", token: TOKEN });
    const { provider, calls } = recordingProvider();

    await prepareRunWorkspace(
      makeInput(ssh, makeContext(), { secrets, vcsProvider: provider }),
      target,
      "/workspace/runs/run_clone/repo",
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.installation).toBeUndefined();
    expect(calls[0]?.staticRef).toBe("credential/github/dev");
    expect(ssh.commands[0]?.command.stdin).toBe(TOKEN);
  });
});
