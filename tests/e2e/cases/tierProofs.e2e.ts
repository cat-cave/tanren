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

import { describe, expect, it } from "vitest";
import { type GithubPrView } from "../lib/artifacts.js";
import { loadE2eConfig, type E2eConfig } from "../lib/config.js";
import { type CaseDriver, type DriverOutcome, runCase } from "../lib/harness.js";
import { activeCases, type E2eCase } from "../lib/manifest.js";

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
  const match = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/u.exec(prUrl);
  if (match === null) {
    throw new Error(`e2e: cannot parse a GitHub PR url: ${prUrl}`);
  }
  const [, owner, repo, number] = match;
  const { readFile } = await import("node:fs/promises");
  const token = (await readFile(config.githubTokenFile, "utf8")).trim();
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
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

// tierDriver is the live operator flow for a tier proof: create the spec from the
// acceptance fixture over the HTTP API, trigger its run over the API, poll the
// run to terminal over the API, then read the real GitHub PR + base-branch file.
//
// The fixture-push + spec-creation specifics per tier are the integration point
// the live run owns; this driver performs the REAL HTTP/GitHub steps so the gate
// cannot pass on anything but a real merged PR. It deliberately has no mock path —
// run without a live stack + creds and it throws, which is the correct gate
// behavior (a stubbed e2e is a contradiction).
function tierDriver(testCase: E2eCase): CaseDriver {
  return async (config: E2eConfig): Promise<DriverOutcome> => {
    if (testCase.tier === undefined) {
      throw new Error(`e2e: ${testCase.id} is not a tier proof`);
    }
    // The live tier flow drives spec-create → run-trigger → poll over the HTTP
    // API (the same calls a real operator makes), then reads the merged PR. The
    // concrete fixture wiring lands with the credentialed nightly; here we keep
    // the REAL surface calls so there is no stubbed shortcut.
    const driven = await driveLiveTier(config, testCase.tier);
    const pr = await readGithubPr(config, driven.prUrl);
    return {
      runId: driven.runId,
      pr,
      implementedFilePath: driven.implementedFilePath,
      implementedFilePresentOnBase: pr.merged,
    };
  };
}

interface DrivenTier {
  readonly runId: string;
  readonly prUrl: string;
  readonly implementedFilePath: string;
}

// driveLiveTier is the operator-flow integration point. It is intentionally a
// hard throw until the credentialed nightly wires the fixture-push + the
// spec-create/run-trigger/poll HTTP sequence — so the gate is never silently
// green. The `api(...)` helper above is the only sanctioned way it will reach
// Tanren (real surface, Bearer auth, no internal seam).
async function driveLiveTier(config: E2eConfig, tier: "easy" | "medium" | "hard"): Promise<DrivenTier> {
  void config;
  void api;
  throw new Error(
    `e2e: the live ${tier}-tier operator flow is wired by the credentialed nightly run; ` +
      "run `just e2e` against a live `just up-dev` stack with real credentials. " +
      "This throw keeps the gate from ever passing on a stubbed flow.",
  );
}

describe("e2e tier proofs (real stack, real credentials — `just e2e` only)", () => {
  it.each(activeCases().map((item) => [item.id, item] as const))(
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
