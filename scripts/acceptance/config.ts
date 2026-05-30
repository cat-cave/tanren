// P2A-0015: acceptance config loader.
//
// Reads operator-supplied credentials and target repo from a single config
// file. Stack-internal details (database URL, Vault addr/token, SSH host/
// port/user/key, SSH host fingerprint) come from the dev-compose contract
// and are auto-discovered or hardcoded — the operator never has to know
// them. Production deployments override the defaults via env vars; the dev
// compose path is zero-config.
//
// Per PROJECT_BRIEF §1.2 invariant 6 ("credentials are managed, not
// discovered"), there is no auto-discovery of ~/.config/{codex,claude,gh}.
// The operator opts in by writing absolute paths into tanren.acceptance.json.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export class AcceptanceConfigError extends Error {}

// -- operator-supplied (per-credential) -----------------------------------

export interface OperatorConfig {
  /** Absolute path to the Codex CLI auth.json bundle (per PROJECT_BRIEF §8). */
  codex_auth_file: string;
  /** Absolute path to a file containing a GitHub token (PAT or App install token). */
  github_token_file: string;
  /** HTTPS URL of the target GitHub repository (e.g. https://github.com/org/repo). */
  github_repo_url: string;
  /** Target base branch on the repo (default: "main"). */
  github_base_branch?: string;
}

// -- dev-compose defaults (overridable) ----------------------------------

interface StackConfig {
  database_url: string;
  vault_addr: string;
  vault_token: string;
  ssh_host: string;
  ssh_port: number;
  ssh_user: string;
  ssh_key_path: string;
  /** SHA256:... fingerprint; auto-discovered from ssh-keyscan if unset. */
  ssh_host_fingerprint?: string;
  timeout_ms: number;
  max_ci_polls: number;
  ci_poll_delay_ms: number;
}

// These match compose.dev.yml. Production overrides every value via env.
const DEV_COMPOSE_DEFAULTS: StackConfig = {
  database_url: "postgres://tanren:tanren@127.0.0.1:5432/tanren",
  vault_addr: "http://127.0.0.1:18200",
  vault_token: "dev-root-token",
  ssh_host: "127.0.0.1",
  ssh_port: 2222,
  ssh_user: "tanren",
  ssh_key_path: "/tmp/tanren_runner_key",
  timeout_ms: 300_000,
  max_ci_polls: 18,
  ci_poll_delay_ms: 10_000,
};

// -- combined acceptance config -------------------------------------------

export interface AcceptanceConfig extends OperatorConfig, Required<StackConfig> {
  /** Where the operator config came from (for error messages). */
  source: string;
}

// loadAcceptanceConfig finds the operator config, merges it with the dev-
// compose stack defaults (overridable per-key by env), and auto-discovers
// the SSH host fingerprint when not specified. Returns a fully-resolved
// config ready for the acceptance script.
//
// Resolution order for the operator config:
//   1. $TANREN_ACCEPTANCE_CONFIG (explicit absolute path)
//   2. ./tanren.acceptance.json (repo root)
//   3. ~/.config/tanren/acceptance.json
//   4. Legacy env vars (TANREN_CODEX_AUTH_JSON_FILE etc.) — emits a one-line
//      deprecation hint pointing at tanren.acceptance.example.json.
export async function loadAcceptanceConfig(): Promise<AcceptanceConfig> {
  const operator = await loadOperatorConfig();
  const stack = loadStackConfig();
  const ssh_host_fingerprint =
    stack.ssh_host_fingerprint ?? (await discoverSshHostFingerprint(stack.ssh_host, stack.ssh_port));
  return {
    ...operator,
    github_base_branch: operator.github_base_branch ?? "main",
    ...stack,
    ssh_host_fingerprint,
    source: operator.source,
  } as AcceptanceConfig;
}

interface LoadedOperatorConfig extends OperatorConfig {
  source: string;
}

async function loadOperatorConfig(): Promise<LoadedOperatorConfig> {
  const candidatePaths = operatorConfigCandidates();
  for (const candidate of candidatePaths) {
    if (existsSync(candidate)) {
      const parsed = await readOperatorConfigFile(candidate);
      return { ...parsed, source: candidate };
    }
  }
  const fromEnv = loadOperatorConfigFromEnv();
  if (fromEnv !== undefined) {
    process.stderr.write(
      "tanren acceptance: legacy TANREN_* env vars detected. Move credentials into tanren.acceptance.json " +
        "(see tanren.acceptance.example.json). Env-var support will be removed in a future spec.\n",
    );
    return { ...fromEnv, source: "env" };
  }
  throw new AcceptanceConfigError(
    `no acceptance config found. Checked:\n${candidatePaths.map((p) => `  - ${p}`).join("\n")}\n` +
      "Copy tanren.acceptance.example.json to tanren.acceptance.json and fill in your credentials. " +
      "See docs/operator-guide/acceptance.md.",
  );
}

function operatorConfigCandidates(): string[] {
  const candidates: string[] = [];
  if (process.env.TANREN_ACCEPTANCE_CONFIG !== undefined && process.env.TANREN_ACCEPTANCE_CONFIG !== "") {
    candidates.push(process.env.TANREN_ACCEPTANCE_CONFIG);
  }
  // Repo root: relative to this file (scripts/acceptance/config.ts), the repo
  // root is two directories up.
  const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  candidates.push(resolve(repoRoot, "tanren.acceptance.json"));
  candidates.push(resolve(homedir(), ".config", "tanren", "acceptance.json"));
  return candidates;
}

async function readOperatorConfigFile(path: string): Promise<OperatorConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new AcceptanceConfigError(`failed to read ${path}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new AcceptanceConfigError(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new AcceptanceConfigError(`${path} must be a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  const requiredKeys = ["codex_auth_file", "github_token_file", "github_repo_url"] as const;
  const missing = requiredKeys.filter((key) => typeof obj[key] !== "string" || (obj[key] as string).trim() === "");
  if (missing.length > 0) {
    throw new AcceptanceConfigError(
      `${path} is missing required keys: ${missing.join(", ")}. Compare against tanren.acceptance.example.json.`,
    );
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

function loadOperatorConfigFromEnv(): OperatorConfig | undefined {
  const codex = process.env.TANREN_CODEX_AUTH_JSON_FILE;
  const github = process.env.TANREN_GITHUB_TOKEN_FILE;
  const repo = process.env.TANREN_GITHUB_REPO_URL;
  if (!codex || !github || !repo) {
    return undefined;
  }
  return {
    codex_auth_file: codex,
    github_token_file: github,
    github_repo_url: repo,
    github_base_branch: process.env.TANREN_GITHUB_BASE_BRANCH,
  };
}

function loadStackConfig(): StackConfig {
  return {
    database_url: process.env.TANREN_DATABASE_URL ?? DEV_COMPOSE_DEFAULTS.database_url,
    vault_addr: process.env.TANREN_VAULT_ADDR ?? DEV_COMPOSE_DEFAULTS.vault_addr,
    vault_token: process.env.TANREN_VAULT_TOKEN ?? DEV_COMPOSE_DEFAULTS.vault_token,
    ssh_host: process.env.TANREN_SSH_HOST ?? DEV_COMPOSE_DEFAULTS.ssh_host,
    ssh_port: numberFromEnv("TANREN_SSH_PORT", DEV_COMPOSE_DEFAULTS.ssh_port),
    ssh_user: process.env.TANREN_SSH_USER ?? DEV_COMPOSE_DEFAULTS.ssh_user,
    ssh_key_path: process.env.TANREN_SSH_KEY_PATH ?? DEV_COMPOSE_DEFAULTS.ssh_key_path,
    ssh_host_fingerprint:
      process.env.TANREN_SSH_HOST_FINGERPRINT !== undefined && process.env.TANREN_SSH_HOST_FINGERPRINT !== ""
        ? process.env.TANREN_SSH_HOST_FINGERPRINT
        : undefined,
    timeout_ms: numberFromEnv("TANREN_ACCEPTANCE_TIMEOUT_MS", DEV_COMPOSE_DEFAULTS.timeout_ms),
    max_ci_polls: numberFromEnv("TANREN_ACCEPTANCE_MAX_CI_POLLS", DEV_COMPOSE_DEFAULTS.max_ci_polls),
    ci_poll_delay_ms: numberFromEnv("TANREN_ACCEPTANCE_CI_POLL_DELAY_MS", DEV_COMPOSE_DEFAULTS.ci_poll_delay_ms),
  };
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new AcceptanceConfigError(`${name} must be a positive number, got ${raw}`);
  }
  return parsed;
}

// discoverSshHostFingerprint runs ssh-keyscan against the runner and extracts
// the SHA256 host-key fingerprint. The Tanren runner image regenerates its
// host keys on every container start (see runner/entrypoint.sh), so the
// fingerprint is correct as long as the script runs against a live stack.
async function discoverSshHostFingerprint(host: string, port: number): Promise<string> {
  const keyscan = spawnSync("ssh-keyscan", ["-p", String(port), "-t", "ed25519", host], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (keyscan.status !== 0 || keyscan.stdout.trim() === "") {
    const stderr = keyscan.stderr?.trim() ?? "";
    throw new AcceptanceConfigError(
      `ssh-keyscan ${host}:${port} failed (is the stack up? \`just up-dev\` or \`docker compose -f compose.dev.yml up -d\`). ` +
        (stderr !== "" ? `stderr: ${stderr}` : ""),
    );
  }
  const keygen = spawnSync("ssh-keygen", ["-lf", "-", "-E", "sha256"], {
    encoding: "utf8",
    input: keyscan.stdout,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (keygen.status !== 0) {
    throw new AcceptanceConfigError(`ssh-keygen failed to read keyscan output: ${keygen.stderr?.trim() ?? ""}`);
  }
  const tokens = keygen.stdout.trim().split(/\s+/u);
  const fingerprint = tokens[1];
  if (fingerprint === undefined || !fingerprint.startsWith("SHA256:")) {
    throw new AcceptanceConfigError(`unexpected ssh-keygen output: ${keygen.stdout}`);
  }
  return fingerprint;
}
