import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../src/engine/contracts/commandSubstrate.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../src/engine/providers/github.js";
import { publishDraftPullRequest } from "../src/engine/workflow/githubDraftPr.js";
import { persistDraftPushIntent } from "../src/engine/workflow/githubDraftPrPushIntent.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import { RecordingPool } from "./helpers/githubDraftPrFakes.js";

const target: RunnerHandle = { backend: "ssh", host: "runner", port: 22, username: "tanren" } as RunnerHandle;
const repoUrl = "https://github.com/cat-cave/repo.git";
const predecessor = "a".repeat(40);
const firstSha = "b".repeat(40);
const rebuiltSha = "c".repeat(40);
const unknownSha = "d".repeat(40);

class RemoteRefHttp implements GitHubHttpClient {
  readonly requests: GitHubHttpRequest[] = [];
  remoteHead: string | undefined;

  async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    this.requests.push({ ...input, token: "<redacted>" });
    if (input.path.includes("/git/ref/heads/")) {
      return this.remoteHead === undefined
        ? { status: 404, body: { message: "Not Found" } }
        : { status: 200, body: { object: { sha: this.remoteHead } } };
    }
    if (input.method === "GET" && input.path.includes("/pulls")) return { status: 200, body: [] };
    if (input.method === "POST" && input.path.includes("/pulls")) {
      return {
        status: 201,
        body: { number: 17, html_url: "https://github.com/cat-cave/repo/pull/17", draft: true, base: { ref: "main" } },
      };
    }
    throw new Error(`unexpected GitHub request: ${input.method} ${input.path}`);
  }
}

class PushSsh implements CommandSubstrate {
  readonly commands: RunnerCommand[] = [];
  constructor(private readonly http: RemoteRefHttp) {}

  async run(_target: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command);
    if (command.command.includes("git push")) {
      const source = command.command.match(/([0-9a-f]{40}):refs\/heads\/tanren\/run_123/u)?.[1];
      if (source === undefined) throw new Error(`missing immutable push source in ${command.command}`);
      this.http.remoteHead = source;
    }
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  }
}

class CrashBeforeWitnessStore extends FakeEventStore {
  private crash = true;

  override async append(input: Parameters<FakeEventStore["append"]>[0]): Promise<void> {
    if (input.eventType === "github.branch.pushed" && this.crash) {
      this.crash = false;
      throw new Error("simulated worker crash after remote CAS");
    }
    await super.append(input);
  }
}

function intentCandidate(intendedSha: string) {
  return {
    orgId: "org_fake",
    projectId: "project_123",
    runId: "run_123",
    specId: "spec_123",
    repoUrl,
    branch: "tanren/run_123",
    intendedSha,
    sourceRef: intendedSha,
    leasePredecessorSha: undefined,
  };
}

function publishInput(
  pool: RecordingPool,
  events: FakeEventStore,
  secrets: FakeSecretStore,
  http: RemoteRefHttp,
  ssh: CommandSubstrate,
  publishedHeadSha: string,
) {
  return {
    pool: pool.asPgPool(),
    eventStore: events,
    secrets,
    githubHttp: http,
    ssh,
    target,
    runId: "run_123",
    specId: "spec_123",
    projectId: "project_123",
    appendEventOrgId: "org_fake",
    workspacePath: "/workspace/runs/run_123/repo",
    repoUrl,
    targetBranch: "main",
    sourceRef: publishedHeadSha,
    publishedHeadSha,
    title: "durable intent",
    githubCredentialRef: "credential/github/org/org_fake/dev",
  };
}

describe("GitHub draft push intent", () => {
  it("re-drives the persisted SHA after a CAS succeeds before the witness, ignoring a rebuilt SHA", async () => {
    const pool = new RecordingPool();
    const http = new RemoteRefHttp();
    const ssh = new PushSsh(http);
    const events = new CrashBeforeWitnessStore();
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: "credential/github/org/org_fake/dev", value: "ghp_secret" });

    await expect(publishDraftPullRequest(publishInput(pool, events, secrets, http, ssh, firstSha))).rejects.toThrow(
      "simulated worker crash after remote CAS",
    );
    expect(http.remoteHead).toBe(firstSha);
    expect(ssh.commands.filter((command) => command.command.includes("git push"))).toHaveLength(1);
    expect([...pool.pushIntents.values()]).toEqual([
      expect.objectContaining({ status: "pending", intended_sha: firstSha }),
    ]);

    await publishDraftPullRequest(publishInput(pool, events, secrets, http, ssh, rebuiltSha));

    expect(http.remoteHead).toBe(firstSha);
    expect(ssh.commands.filter((command) => command.command.includes("git push"))).toHaveLength(1);
    expect(ssh.commands[0]?.command).toContain(`${firstSha}:refs/heads/tanren/run_123`);
    expect(ssh.commands[0]?.command).not.toContain(`${rebuiltSha}:refs/heads/tanren/run_123`);
    expect(events.events.filter((event) => event.eventType === "github.branch.pushed")).toHaveLength(1);
    expect(events.events.find((event) => event.eventType === "github.branch.pushed")?.payload).toMatchObject({
      headSha: firstSha,
      sourceRef: firstSha,
    });
    expect([...pool.pushIntents.values()]).toEqual([
      expect.objectContaining({ status: "completed", intended_sha: firstSha }),
    ]);
  });

  it("fails closed when a pending intent meets an unknown remote ref", async () => {
    const pool = new RecordingPool();
    const intent = await persistDraftPushIntent(pool.asPgPool(), {
      ...intentCandidate(firstSha),
      leasePredecessorSha: predecessor,
    });
    const http = new RemoteRefHttp();
    http.remoteHead = unknownSha;
    const ssh = new PushSsh(http);
    const events = new FakeEventStore();
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: "credential/github/org/org_fake/dev", value: "ghp_secret" });
    await expect(publishDraftPullRequest(publishInput(pool, events, secrets, http, ssh, rebuiltSha))).rejects.toThrow(
      "changed since workspace rework",
    );
    expect(ssh.commands.filter((command) => command.command.includes("git push"))).toHaveLength(0);
    expect(intent.status).toBe("pending");
  });

  it("serializes concurrent candidates behind one org/spec/branch intent", async () => {
    const pool = new RecordingPool();
    const [first, second] = await Promise.all([
      persistDraftPushIntent(pool.asPgPool(), intentCandidate(firstSha)),
      persistDraftPushIntent(pool.asPgPool(), intentCandidate(rebuiltSha)),
    ]);
    expect(second.intentId).toBe(first.intentId);
    expect(second.intendedSha).toBe(first.intendedSha);
    expect(pool.pushIntents.size).toBe(1);
  });
});
