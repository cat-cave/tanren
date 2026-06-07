// P8b — the three tier-proof e2e cases (autonomy-engine §8b / §0 A).
//
// CREDENTIALED + REAL. This file is named `*.e2e.ts` (not `*.test.ts`) so
// vitest's default discovery never picks it up; only `just e2e` runs it
// explicitly against a live stack (`just up-dev`) with real Codex + GitHub
// credentials. It NEVER runs in `just fast-check` / public PR CI.
//
// It drives the REAL operator flow over the REAL external surfaces only — the
// HTTP API here (the dashboard slices grow per the manifest) — then asserts on
// the REAL persisted artifacts each tier-proof case declares (a merged PR, the
// implemented file on the base branch, real cost_records, the DORA projection).
// The `e2e-no-mock-imports` architecture check forbids any fixture/mock/internal
// seam import in this file.
//
// SKIP-GATING: the three tier proofs are declared `active` in the manifest, but
// they require a live stack + real credentials to drive. So the suite gates the
// whole live path behind `liveCredsAvailable()` (TANREN_E2E_API_TOKEN + the
// acceptance/e2e config file the live recipes read). Without creds/stack each
// case SKIPS cleanly (it.skipIf) — it never throws and never silently passes, so
// the suite is never falsely green.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type GithubPrView } from "../lib/artifacts.js";
import { loadE2eConfig, type E2eConfig } from "../lib/config.js";
import { type CaseDriver, type DriverOutcome, runCase } from "../lib/harness.js";
import { activeCases, type E2eCase } from "../lib/manifest.js";

// liveCredsAvailable is the e2e/live switch the suite gates on. It mirrors the
// `just e2e` recipe's preconditions (TANREN_E2E_API_TOKEN + an acceptance/e2e
// config file — the same file the `just live-*` recipes read) WITHOUT throwing,
// so a no-creds run cleanly SKIPS rather than erroring. The credentialed nightly
// (`just up-dev` + a real api_token + tanren.acceptance.json) flips this on.
function liveCredsAvailable(): boolean {
  const token = process.env.TANREN_E2E_API_TOKEN;
  if (token === undefined || token.trim() === "") {
    return false;
  }
  return acceptanceConfigCandidates().some((candidate) => existsSync(candidate));
}

function acceptanceConfigCandidates(): string[] {
  const candidates: string[] = [];
  const explicit = process.env.TANREN_ACCEPTANCE_CONFIG;
  if (explicit !== undefined && explicit !== "") {
    candidates.push(explicit);
  }
  candidates.push(resolve(process.cwd(), "tanren.acceptance.json"));
  candidates.push(resolve(homedir(), ".config", "tanren", "acceptance.json"));
  return candidates;
}

// The Bearer token the operator's API client presents (a real api_token issued
// for the e2e operator). Required so the suite drives the API exactly as a real
// user would — there is no internal-seam bypass.
function apiToken(): string {
  const token = process.env.TANREN_E2E_API_TOKEN;
  if (token === undefined || token.trim() === "") {
    throw new Error(
      "TANREN_E2E_API_TOKEN is required: the e2e gate drives the real HTTP API as a real operator (Bearer auth). " +
        "Issue an api_token for the e2e operator and export it. See docs/operator-guide/e2e.md.",
    );
  }
  return token.trim();
}

// A thin typed wrapper over the real HTTP operator surface. Every Tanren
// interaction in the live flow goes through here — no internal call.
async function api(config: E2eConfig, method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${config.apiBaseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiToken()}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error(`e2e API ${method} ${path} → ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

// readGithubPr reads the REAL merged state of a PR from the GitHub REST API — the
// artifact the merged_pr assertion checks. The PR number is parsed from the
// pr_url the run persisted; the token comes from the operator's config.
async function readGithubPr(config: E2eConfig, prUrl: string): Promise<GithubPrView> {
  const { owner, repo, number } = parsePrUrl(prUrl);
  const token = await readGithubToken(config);
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`, {
    headers: githubHeaders(token),
  });
  if (!response.ok) {
    throw new Error(`e2e: GitHub PR read failed ${response.status}: ${await response.text()}`);
  }
  const pr = (await response.json()) as { merged?: boolean; merge_commit_sha?: string | null; base?: { ref?: string } };
  return {
    merged: pr.merged === true,
    mergeCommitSha: pr.merge_commit_sha ?? null,
    baseBranch: pr.base?.ref ?? config.baseBranch,
  };
}

// readGithubFileOnBase reads the GitHub contents API for the implemented file at
// the base branch. A 200 means the file genuinely landed on the base branch
// after the merge — the implemented_file artifact, observed over the real GitHub
// surface (not inferred from the PR's merged flag).
async function readGithubFileOnBase(config: E2eConfig, filePath: string): Promise<boolean> {
  const { owner, repo } = parsePrUrl(config.githubRepoUrl, { repoOnly: true });
  const token = await readGithubToken(config);
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(config.baseBranch)}`,
    { headers: githubHeaders(token) },
  );
  if (response.status === 404) {
    return false;
  }
  if (!response.ok) {
    throw new Error(`e2e: GitHub contents read failed ${response.status}: ${await response.text()}`);
  }
  return true;
}

function githubHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" };
}

async function readGithubToken(config: E2eConfig): Promise<string> {
  return (await readFile(config.githubTokenFile, "utf8")).trim();
}

function parsePrUrl(
  url: string,
  options: { repoOnly?: boolean } = {},
): {
  owner: string;
  repo: string;
  number: string;
} {
  const pattern = options.repoOnly
    ? /github\.com\/([^/]+)\/([^/.]+)(?:\.git)?\/?$/u
    : /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/u;
  const match = pattern.exec(url);
  if (match === null) {
    throw new Error(`e2e: cannot parse a GitHub ${options.repoOnly ? "repo" : "PR"} url: ${url}`);
  }
  return { owner: match[1], repo: match[2], number: match[3] ?? "" };
}

// tierDriver is the live operator flow for a tier proof: create the project +
// spec from the tier fixture over the HTTP API, trigger its run over the API,
// poll the run to terminal over the API, then read the real GitHub PR + the
// base-branch file. There is no mock path — it drives only the real surfaces.
function tierDriver(testCase: E2eCase): CaseDriver {
  return async (config: E2eConfig): Promise<DriverOutcome> => {
    if (testCase.tier === undefined) {
      throw new Error(`e2e: ${testCase.id} is not a tier proof`);
    }
    const driven = await driveLiveTier(config, testCase.tier);
    const pr = await readGithubPr(config, driven.prUrl);
    const implementedFilePresentOnBase = await readGithubFileOnBase(config, driven.implementedFilePath);
    return {
      runId: driven.runId,
      pr,
      implementedFilePath: driven.implementedFilePath,
      implementedFilePresentOnBase,
    };
  };
}

interface DrivenTier {
  readonly runId: string;
  readonly prUrl: string;
  readonly implementedFilePath: string;
}

// The terminal run statuses the poll stops on. `done`/`completed` are the
// merged-success terminals the tier proofs require; the failure terminals are
// included so the poll never spins past a halted/failed/cancelled run (the
// assertions then fail the case on the non-merged outcome).
const TERMINAL_STATUSES = new Set(["done", "completed", "halted", "failed", "cancelled"]);

// driveLiveTier drives the REAL operator flow for a tier over the HTTP API:
//   GET  /orgs                                  → the operator's org
//   POST /orgs/:orgId/credentials               → import codex + github creds
//   POST /orgs/:orgId/projects                  → create the target-repo project
//   POST /orgs/:orgId/projects/:id/specs        → create the tier's marker spec
//   POST /orgs/:orgId/projects/:id/specs/:id/runs → trigger the run
//   GET  /runs/:runId                           → poll to a terminal status
// It returns the run id, the persisted PR url, and the implemented file path so
// the driver can read the real merged PR + base-branch file. No fixture, no
// internal seam — exactly the calls a real operator makes.
async function driveLiveTier(config: E2eConfig, tier: "easy" | "medium" | "hard"): Promise<DrivenTier> {
  const unique = `${tier}-${Date.now()}`;
  const fixture = tierFixture(tier, unique);
  const orgId = await firstOrgId(config);

  const codexCredentialRef = await importCredential(config, orgId, "codex_chatgpt_auth", {
    ref: `e2e-codex-${unique}`,
    authJson: await readFile(config.codexAuthFile, "utf8"),
  });
  const githubCredentialRef = await importCredential(config, orgId, "github_token", {
    ref: `e2e-github-${unique}`,
    token: await readGithubToken(config),
  });

  const project = (await api(config, "POST", `/orgs/${orgId}/projects`, {
    name: `e2e-${unique}`,
    repoUrl: config.githubRepoUrl,
    defaultBranch: config.baseBranch,
    config: {
      version: 1,
      // The hard tier closes the human-review tier with the in-loop simulated
      // reviewer (CLAUDE.md: reviewPolicy: simulated); easy/medium auto-merge.
      reviewPolicy: tier === "hard" ? "simulated" : "auto",
      credentials: {
        defaultLlm: { cli: "codex", model: "default", authRef: codexCredentialRef },
        githubCredentialRef,
      },
    },
  })) as { projectId: string };

  const spec = (await api(config, "POST", `/orgs/${orgId}/projects/${project.projectId}/specs`, {
    title: fixture.title,
    description: fixture.description,
    acceptanceCriteria: fixture.acceptanceCriteria,
  })) as { specId: string };

  const run = (await api(config, "POST", `/orgs/${orgId}/projects/${project.projectId}/specs/${spec.specId}/runs`, {
    trigger: "api",
    branch: `tanren/e2e-${unique}`,
  })) as { runId: string };

  const prUrl = await pollRunToTerminal(config, run.runId);
  return { runId: run.runId, prUrl, implementedFilePath: fixture.implementedFilePath };
}

// firstOrgId reads the operator's orgs and returns the one to drive. The e2e
// operator is provisioned with exactly the org the gate targets; `TANREN_E2E_ORG_ID`
// overrides when the operator belongs to several.
async function firstOrgId(config: E2eConfig): Promise<string> {
  const explicit = process.env.TANREN_E2E_ORG_ID;
  if (explicit !== undefined && explicit.trim() !== "") {
    return explicit.trim();
  }
  const body = (await api(config, "GET", "/orgs")) as { orgs: Array<{ id: string }> };
  const orgId = body.orgs[0]?.id;
  if (orgId === undefined) {
    throw new Error("e2e: the operator belongs to no org; export TANREN_E2E_ORG_ID or provision one");
  }
  return orgId;
}

async function importCredential(
  config: E2eConfig,
  orgId: string,
  kind: "codex_chatgpt_auth" | "github_token",
  body: Record<string, string>,
): Promise<string> {
  const stored = (await api(config, "POST", `/orgs/${orgId}/credentials?kind=${kind}`, body)) as { ref: string };
  return stored.ref;
}

// pollRunToTerminal polls `GET /runs/:runId` until the run reaches a terminal
// status (or the deadline), then returns the persisted pr_url. The assertions in
// the harness decide whether the terminal status + PR are a real merged proof;
// here we only resolve a stable terminal observation.
async function pollRunToTerminal(config: E2eConfig, runId: string): Promise<string> {
  const deadline = Date.now() + Number(process.env.TANREN_E2E_RUN_TIMEOUT_MS ?? "1500000");
  const intervalMs = Number(process.env.TANREN_E2E_POLL_INTERVAL_MS ?? "10000");
  for (;;) {
    const body = (await api(config, "GET", `/runs/${runId}`)) as {
      run: { status: string; pr_url: string | null };
    };
    if (TERMINAL_STATUSES.has(body.run.status)) {
      if (body.run.pr_url === null) {
        throw new Error(`e2e: run ${runId} reached terminal status "${body.run.status}" with no pr_url`);
      }
      return body.run.pr_url;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `e2e: run ${runId} did not reach a terminal status before the deadline (last: ${body.run.status})`,
      );
    }
    await sleep(intervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

interface TierFixture {
  readonly title: string;
  readonly description: string;
  readonly acceptanceCriteria: readonly string[];
  readonly implementedFilePath: string;
}

// tierFixture is the per-tier spec the operator submits. Each tier instructs a
// deterministic marker file at a known path (so the implemented_file artifact is
// checkable on the base branch), with a unique suffix so reruns never collide.
// The medium tier asks for a second helper file (the subtask split); the hard
// tier targets the same marker on the private repo behind the simulated review.
function tierFixture(tier: "easy" | "medium" | "hard", unique: string): TierFixture {
  const marker = `TANREN_E2E_${tier.toUpperCase()}_${unique.replaceAll(/[^A-Za-z0-9_]/gu, "_")}`;
  const filePath = `${marker}.md`;
  const line = `tanren e2e ${tier} ok ${unique}`;
  if (tier === "medium") {
    return {
      title: `[e2e medium] add ${filePath} (+ helper)`,
      description:
        `Create ${filePath} containing exactly the line: ${line}. ` +
        `Also create ${marker}_HELPER.md containing exactly: ${line} helper. ` +
        "Split the work into subtasks.",
      acceptanceCriteria: [
        `${filePath} contains exactly ${line}`,
        `${marker}_HELPER.md contains exactly ${line} helper`,
      ],
      implementedFilePath: filePath,
    };
  }
  return {
    title: `[e2e ${tier}] add ${filePath}`,
    description: `Create ${filePath} containing exactly the line: ${line}.`,
    acceptanceCriteria: [`${filePath} contains exactly ${line}`],
    implementedFilePath: filePath,
  };
}

const live = liveCredsAvailable();

describe("e2e tier proofs (real stack, real credentials — `just e2e` only)", () => {
  it.skipIf(!live).each(activeCases().map((item) => [item.id, item] as const))(
    "%s reaches a real merged PR and proves every declared artifact",
    async (_id, testCase) => {
      const config = await loadE2eConfig();
      const result = await runCase({ testCase, driver: tierDriver(testCase), config });
      expect(result.problems).toEqual([]);
      expect(result.passed).toBe(true);
      expect(result.prUrl).toMatch(/^https:\/\/github\.com\/.+\/pull\/\d+$/u);
    },
  );
});
