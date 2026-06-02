// P8b — e2e gate config (autonomy-engine §8b).
//
// The e2e gate talks to Tanren ONLY through real external surfaces, so its
// config is just the coordinates of those surfaces + the operator credentials it
// needs to drive them: the orchestrator HTTP base URL, the dashboard base URL,
// the target GitHub repo + a token (to read the real merged-PR artifact), and the
// Postgres URL (to read the real persisted run/cost/DORA rows). No internal-seam
// config, no fixture paths — by design (§8b "no internal seams").
//
// It reads the same operator file the acceptance gate uses
// (tanren.acceptance.json — see docs/operator-guide/acceptance.md) so an operator
// configures credentials once. Stack coordinates default to the dev-compose
// contract and are overridable per-key by env.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

export class E2eConfigError extends Error {}

export interface E2eConfig {
  /** Orchestrator HTTP API base URL (the real operator surface). */
  readonly apiBaseUrl: string;
  /** Dashboard base URL (the real operator surface for the Playwright slices). */
  readonly dashboardBaseUrl: string;
  /** HTTPS URL of the target GitHub repo (where merged PRs are asserted). */
  readonly githubRepoUrl: string;
  /** Absolute path to a file holding a GitHub token (reads the real PR artifact). */
  readonly githubTokenFile: string;
  /** Absolute path to the Codex CLI auth bundle (the real provider credential). */
  readonly codexAuthFile: string;
  /** Target base branch on the repo (default "main"). */
  readonly baseBranch: string;
  /** Postgres URL used ONLY to read real persisted artifacts (runs/cost/DORA). */
  readonly databaseUrl: string;
  /** Where the operator config was read from (for error messages). */
  readonly source: string;
}

const DEFAULTS = {
  apiBaseUrl: "http://127.0.0.1:3100",
  dashboardBaseUrl: "http://127.0.0.1:3000",
  databaseUrl: "postgres://tanren:tanren@127.0.0.1:5432/tanren",
  baseBranch: "main",
} as const;

function operatorConfigCandidates(): string[] {
  const candidates: string[] = [];
  const explicit = process.env.TANREN_ACCEPTANCE_CONFIG;
  if (explicit !== undefined && explicit !== "") {
    candidates.push(explicit);
  }
  candidates.push(resolve(process.cwd(), "tanren.acceptance.json"));
  candidates.push(resolve(homedir(), ".config", "tanren", "acceptance.json"));
  return candidates;
}

interface OperatorFile {
  readonly codex_auth_file: string;
  readonly github_token_file: string;
  readonly github_repo_url: string;
  readonly github_base_branch?: string;
}

async function readOperatorFile(path: string): Promise<OperatorFile> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new E2eConfigError(`failed to read ${path}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new E2eConfigError(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new E2eConfigError(`${path} must be a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  const required = ["codex_auth_file", "github_token_file", "github_repo_url"] as const;
  const missing = required.filter((key) => typeof obj[key] !== "string" || (obj[key] as string).trim() === "");
  if (missing.length > 0) {
    throw new E2eConfigError(`${path} is missing required keys: ${missing.join(", ")}`);
  }
  return {
    codex_auth_file: (obj.codex_auth_file as string).trim(),
    github_token_file: (obj.github_token_file as string).trim(),
    github_repo_url: (obj.github_repo_url as string).trim(),
    github_base_branch:
      typeof obj.github_base_branch === "string" && obj.github_base_branch.trim() !== ""
        ? obj.github_base_branch.trim()
        : undefined,
  };
}

export async function loadE2eConfig(): Promise<E2eConfig> {
  const candidates = operatorConfigCandidates();
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new E2eConfigError(
      `no e2e/acceptance config found. Checked:\n${candidates.map((p) => `  - ${p}`).join("\n")}\n` +
        "Copy tanren.acceptance.example.json to tanren.acceptance.json and fill in your credentials. " +
        "See docs/operator-guide/e2e.md.",
    );
  }
  const operator = await readOperatorFile(found);
  return {
    apiBaseUrl: process.env.TANREN_E2E_API_URL ?? DEFAULTS.apiBaseUrl,
    dashboardBaseUrl: process.env.TANREN_E2E_DASHBOARD_URL ?? DEFAULTS.dashboardBaseUrl,
    githubRepoUrl: operator.github_repo_url,
    githubTokenFile: operator.github_token_file,
    codexAuthFile: operator.codex_auth_file,
    baseBranch: operator.github_base_branch ?? process.env.TANREN_GITHUB_BASE_BRANCH ?? DEFAULTS.baseBranch,
    databaseUrl: process.env.TANREN_DATABASE_URL ?? DEFAULTS.databaseUrl,
    source: found,
  };
}
