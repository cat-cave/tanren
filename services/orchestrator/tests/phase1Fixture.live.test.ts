import { readFile } from "node:fs/promises";
import { createDbPool, migrate } from "@tanren/db";
import type { ServerHostKeyAlgorithm } from "ssh2";
import { describe, expect, it } from "vitest";
import { LocalDockerAllocator, PgRunnerStore } from "../src/engine/allocators/index.js";
import { type SecretStore, VaultSecretStore } from "../src/engine/contracts/secretStore.js";
import { storeCodexAuthBundle } from "../src/engine/credentials/codexAuth.js";
import { storeGithubToken } from "../src/engine/credentials/githubToken.js";
import { FetchGitHubHttpClient } from "../src/engine/providers/github.js";
import { createCodexAnswerer, createCodexWriter } from "../src/engine/providers/codex.js";
import { Ssh2Substrate } from "../src/engine/ssh/index.js";
import { createProject, createQueuedRunFromSpec, createSpec } from "../src/engine/workflow/projectSpec.js";
import { runPhase1FixtureWorkflow } from "../src/engine/workflow/phase1Fixture.js";

const runLive = process.env.TANREN_PHASE1_FIXTURE_LIVE === "1";
const describeLive = runLive ? describe : describe.skip;

describeLive("live phase 1 fixture workflow", () => {
  it("runs Codex writer/check/audit, creates a draft PR, and records passing CI", async () => {
    const timeoutMs = Number(process.env.TANREN_PHASE1_FIXTURE_TIMEOUT_MS ?? "300000");
    const repoUrl = requireEnv("TANREN_GITHUB_REPO_URL");
    const baseBranch = process.env.TANREN_GITHUB_BASE_BRANCH ?? "main";
    const unique = Date.now();
    const markerFile = `TANREN_PHASE1_${unique}.md`;
    const markerLine = `tanren phase 1 fixture ok ${unique}`;
    const secrets = createLiveSecretStore();
    await storeCodexAuthBundle(secrets, {
      ref: "credential/codex/phase1-live",
      authJson: await readFile(requireEnv("TANREN_CODEX_AUTH_JSON_FILE"), "utf8")
    });
    await storeGithubToken(secrets, {
      ref: "credential/github/phase1-live",
      token: await readFile(requireEnv("TANREN_GITHUB_TOKEN_FILE"), "utf8")
    });
    await secrets.put({ ref: "runner/live/identity", value: await readFile(requireEnv("TANREN_SSH_KEY_PATH"), "utf8") });
    const pool = createDbPool(process.env.DATABASE_URL ?? "postgres://tanren:tanren@localhost:5432/tanren");
    await migrate(pool);
    const ssh = new Ssh2Substrate(secrets, {
      serverHostKeyAlgorithms: parseHostKeyAlgorithms(process.env.TANREN_SSH_HOST_KEY_ALGORITHMS)
    });

    const project = await createProject(pool, {
      name: `phase1-live-${unique}`,
      repoUrl,
      defaultBranch: baseBranch,
      config: { githubCredentialRef: "credential/github/phase1-live" }
    });
    const spec = await createSpec(pool, {
      projectId: project.projectId,
      title: `Add ${markerFile}`,
      description: `Create ${markerFile} containing exactly ${markerLine}.`,
      acceptanceCriteria: [`${markerFile} contains exactly ${markerLine}`]
    });
    const run = await createQueuedRunFromSpec(pool, { specId: spec.specId, branch: `tanren/phase1-live-${unique}` });
    const result = await runPhase1FixtureWorkflow({
      pool,
      allocator: new LocalDockerAllocator({
        runners: new PgRunnerStore(pool),
        sshHost: process.env.TANREN_SSH_HOST ?? "127.0.0.1",
        sshPort: Number(process.env.TANREN_SSH_PORT ?? "2222"),
        sshUsername: process.env.TANREN_SSH_USER ?? "tanren"
      }),
      ssh,
      secrets,
      githubHttp: new FetchGitHubHttpClient(),
      context: {
        runId: run.runId,
        specId: run.specId,
        projectId: run.projectId,
        repoUrl,
        targetBranch: baseBranch,
        runBranch: run.branch,
        specTitle: spec.title,
        specDescription: spec.description,
        acceptanceCriteria: spec.acceptanceCriteria,
        runnerImage: project.runnerImage,
        identitySecretRef: "runner/live/identity",
        githubCredentialRef: "credential/github/phase1-live"
      },
      createWriter: ({ target, runId }) =>
        createCodexWriter({ secrets, ssh, target, credentialRef: "credential/codex/phase1-live", runId: `${runId}_writer` }),
      createChecker: ({ target, runId }) =>
        createCodexAnswerer({ secrets, ssh, target, credentialRef: "credential/codex/phase1-live", runId: `${runId}_check` }),
      createAuditor: ({ target, runId }) =>
        createCodexAnswerer({ secrets, ssh, target, credentialRef: "credential/codex/phase1-live", runId: `${runId}_audit` }),
      timeoutMs,
      maxCiPolls: Number(process.env.TANREN_PHASE1_FIXTURE_MAX_CI_POLLS ?? "18"),
      ciPollDelayMs: Number(process.env.TANREN_PHASE1_FIXTURE_CI_POLL_DELAY_MS ?? "10000")
    });

    const tasks = await pool.query("SELECT kind, status, outcome FROM tasks WHERE run_id = $1 ORDER BY started_at ASC NULLS LAST", [
      run.runId
    ]);
    const events = await pool.query("SELECT event_type FROM events WHERE run_id = $1 ORDER BY ts ASC, id ASC", [run.runId]);
    const runRow = await pool.query("SELECT status, outcome, pr_url FROM runs WHERE run_id = $1", [run.runId]);
    await pool.end();

    expect(result.writer.diff).toContain(markerFile);
    expect(result.check.done).toBe(true);
    expect(result.audit.verified).toBe(true);
    expect(result.pullRequest.prUrl).toMatch(/^https:\/\/github\.com\/.+\/pull\/\d+$/);
    expect(result.ci.status).toBe("passed");
    expect(runRow.rows[0]).toMatchObject({ status: "done", outcome: "phase1_fixture_complete", pr_url: result.pullRequest.prUrl });
    expect(tasks.rows.map((row) => row.kind)).toEqual(expect.arrayContaining(["plan", "write", "check", "audit", "ci"]));
    expect(events.rows.map((row) => row.event_type)).toEqual(
      expect.arrayContaining(["phase1.fixture.completed", "github.pr.created", "ci.passed"])
    );
  }, Number(process.env.TANREN_PHASE1_FIXTURE_TIMEOUT_MS ?? "300000") * 3);
});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function createLiveSecretStore(): SecretStore {
  return new VaultSecretStore({
    addr: process.env.TANREN_VAULT_ADDR ?? "http://127.0.0.1:18200",
    token: process.env.TANREN_VAULT_TOKEN ?? "dev-root-token"
  });
}

function parseHostKeyAlgorithms(value: string | undefined): ServerHostKeyAlgorithm[] | undefined {
  return value?.split(",").map((item) => item.trim()).filter((item) => item !== "") as ServerHostKeyAlgorithm[] | undefined;
}
