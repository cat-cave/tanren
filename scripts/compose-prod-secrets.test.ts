import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Codex r5 (deploy-secret residual): the prod compose must deliver EVERY secret as a
// MOUNTED FILE under /run/secrets — never a plaintext env VALUE that would show up in
// the rendered `docker compose config` / `docker inspect` / `/proc/<pid>/environ`.
// This renders the prod profile with SYNTHETIC secret files and asserts:
//   1. each secret value is NOT present anywhere in the rendered config (no plaintext);
//   2. each secret is wired as a `/run/secrets/*` file mount;
//   3. the Vault server carries NO `VAULT_DEV_ROOT_TOKEN_ID` plaintext env (the root
//      token is read from the mounted file by the entrypoint instead).
// Skips (does not fail) when the docker CLI is unavailable in the runner.

const repoRoot = resolve(import.meta.dirname, "..");
const composeFile = resolve(repoRoot, "compose.prod.yml");

function dockerAvailable(): boolean {
  const probe = spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
  return probe.status === 0;
}

function renderProdConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), "tanren-prod-secrets-"));
  // Distinctive sentinel VALUES — if any leaks into the rendered env, the assertion fails.
  const secretFiles = {
    VAULT: "SENTINEL-VAULT-ROOT-TOKEN",
    OAUTH: "SENTINEL-OAUTH-CLIENT-SECRET",
    ALLOC: "SENTINEL-ALLOCATOR-TOKEN",
    RUNNER: "SENTINEL-RUNNER-KEY",
    TLS: "SENTINEL-TLS",
  };
  const path = (name: string, contents: string): string => {
    const p = join(dir, name);
    writeFileSync(p, contents);
    return p;
  };
  const env: Record<string, string> = {
    ...process.env,
    TANREN_VAULT_TOKEN_FILE: path("vault_token", secretFiles.VAULT),
    TANREN_GITHUB_OAUTH_CLIENT_SECRET_FILE: path("oauth_secret", secretFiles.OAUTH),
    TANREN_ALLOCATOR_TOKEN_FILE: path("alloc_token", secretFiles.ALLOC),
    TANREN_RUNNER_IDENTITY_KEY_FILE: path("runner_key", secretFiles.RUNNER),
    POSTGRES_PASSWORD: "pg-pass",
    TANREN_APP_DB_PASSWORD: "app-pass",
    TANREN_SYSTEM_DB_PASSWORD: "system-pass",
    TANREN_DATAPLANE_DB_PASSWORD: "dataplane-pass",
    TANREN_GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    TANREN_PUBLIC_BASE_URL: "https://tanren.example.com",
    TANREN_RUNNER_AUTHORIZED_KEY: "ssh-ed25519 AAAApublic tanren",
    TANREN_INTERNAL_TLS_CERT: path("tls_cert", secretFiles.TLS),
    TANREN_INTERNAL_TLS_KEY: path("tls_key", secretFiles.TLS),
    TANREN_INTERNAL_TLS_CA: path("tls_ca", secretFiles.TLS),
    TANREN_CLAIM_ENDPOINT_URL: "https://orchestrator:3110",
    TANREN_DATA_PLANE_TLS_CERT: path("dp_cert", secretFiles.TLS),
    TANREN_DATA_PLANE_TLS_KEY: path("dp_key", secretFiles.TLS),
    TANREN_DATA_PLANE_TLS_CA: path("dp_ca", secretFiles.TLS),
  };
  const result = spawnSync("docker", ["compose", "-f", composeFile, "config"], { encoding: "utf8", env });
  if (result.status !== 0) {
    throw new Error(`docker compose config failed:\n${result.stderr}`);
  }
  return result.stdout;
}

// Render once, lazily, only when docker is present (the describe is skipped
// otherwise). Memoized so the four assertions share a single `docker compose config`.
const hasDocker = dockerAvailable();
let cachedRendered: string | undefined;
function rendered(): string {
  cachedRendered ??= renderProdConfig();
  return cachedRendered;
}

describe.skipIf(!hasDocker)(
  "compose.prod.yml — every prod secret is a file mount, never plaintext env (Codex r5)",
  () => {
    it("renders a valid prod config (docker compose config succeeds)", () => {
      expect(rendered()).toContain("services:");
    });

    it("never exposes any secret VALUE as plaintext in the rendered config", () => {
      for (const sentinel of [
        "SENTINEL-VAULT-ROOT-TOKEN",
        "SENTINEL-OAUTH-CLIENT-SECRET",
        "SENTINEL-ALLOCATOR-TOKEN",
        "SENTINEL-RUNNER-KEY",
      ]) {
        expect(rendered()).not.toContain(sentinel);
      }
    });

    it("wires each secret as a /run/secrets/* file mount", () => {
      expect(rendered()).toContain("/run/secrets/tanren_vault_token");
      expect(rendered()).toContain("/run/secrets/tanren_github_oauth_client_secret");
      expect(rendered()).toContain("/run/secrets/tanren_allocator_token");
      expect(rendered()).toContain("/run/secrets/tanren_runner_identity_key");
    });

    it("does NOT declare the Vault dev root token as a Docker ENV (read from the mounted file instead)", () => {
      // The old `VAULT_DEV_ROOT_TOKEN_ID: ${VAULT_ROOT_TOKEN}` plaintext Docker env is
      // gone — the vault entrypoint reads /run/secrets/tanren_vault_token and seeds the
      // dev root token id as an argv. The name may still appear inside the entrypoint
      // SHELL script (a local shell var, not a container env), so assert specifically
      // that it is not a DECLARED environment key (`  VAULT_DEV_ROOT_TOKEN_ID: ...`).
      expect(rendered()).not.toMatch(/^\s+VAULT_DEV_ROOT_TOKEN_ID:\s/mu);
    });

    it("reads the prod secrets through the *_FILE env knobs the code resolves file-preferred", () => {
      expect(rendered()).toContain(
        "TANREN_GITHUB_OAUTH_CLIENT_SECRET_FILE: /run/secrets/tanren_github_oauth_client_secret",
      );
      expect(rendered()).toContain("TANREN_ALLOCATOR_TOKEN_FILE: /run/secrets/tanren_allocator_token");
      expect(rendered()).toContain("VAULT_TOKEN_FILE: /run/secrets/tanren_vault_token");
      // The plaintext-VALUE forms must NOT appear as declared env keys.
      expect(rendered()).not.toMatch(/TANREN_GITHUB_OAUTH_CLIENT_SECRET:/u);
      expect(rendered()).not.toMatch(/TANREN_ALLOCATOR_TOKEN:/u);
    });
  },
);
