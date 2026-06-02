import { readFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { createDbPool, migrate, PgNotifyListener } from "@tanren/db";
import { Hono } from "hono";
import type pg from "pg";
import { buildAuthFromEnv, type BuildAppAuthOptions } from "./mainAuth.js";
import { buildSecretStore, type SecretStore, type SshSubstrate } from "./engine/contracts/index.js";
import { FetchGitHubHttpClient, type GitHubHttpClient } from "./engine/providers/github.js";
import { buildVcsProvider } from "./engine/providers/buildVcsProvider.js";
import { GithubAppTokenMinter } from "./engine/providers/githubAppTokenMinter.js";
import { FetchConfigGateGitHub } from "./engine/config/configGateGithub.js";
import { loadOrgGithubAppInstallation } from "./engine/credentials/orgGithubApp.js";
import { resolveGithubToken } from "./engine/credentials/githubTokenResolver.js";
import type { ConfigGateGithubFactory } from "./routes/orgs/index.js";
import { TimedGitHubHttpClient, TimedSshSubstrate } from "./engine/observability/index.js";
import { Ssh2Substrate } from "./engine/ssh/index.js";
import { buildAllocatorFromEnv } from "./engine/allocators/buildAllocator.js";
import { bootRunWorker, runWorkerEnabled } from "./engine/worker/index.js";
import { startInternalMtlsServer } from "./internalServer.js";
import { createAuthMiddleware, type ActorContextEnv } from "./middleware/auth.js";
import { createAuthRoutes } from "./routes/auth/index.js";
import { SecretStoreCredentialRegistry, type CredentialRegistry } from "./routes/credentials/index.js";
import { mountFeatureRoutes } from "./mountFeatureRoutes.js";
import { mountRootApiRoutes } from "./mountRootApiRoutes.js";

export { buildAuthFromEnv, type BuildAppAuthOptions } from "./mainAuth.js";

const port = Number(process.env["ORCHESTRATOR_PORT"] ?? 3100);
const vaultAddr = process.env["VAULT_ADDR"] ?? "http://localhost:8200";
const runnerIdentitySecretRef = process.env["TANREN_RUNNER_IDENTITY_SECRET_REF"] ?? "runner/local-docker/identity";

/**
 * Require a non-blank env var; throw a clear error when unset/blank (NO fallback).
 * Mirrors `required(env, ...)` in secretStoreFactory.ts. Resolved at the point of
 * USE (not at module load) so importing this module for `buildApp` tests — which
 * inject their own `vaultHealthCheck` — does not require the production env.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required (set it in the environment; there is no default)`);
  }
  return value;
}

let productionPool: pg.Pool | undefined;

async function vaultHealth() {
  // The broad Vault token is REQUIRED — there is NO `dev-root-token` fallback (the
  // dev stack sets a real VAULT_TOKEN in env). This token is the orchestrator's
  // broad credential; it is used ONLY to read Vault health and to MINT per-run
  // scoped child tokens — it is never handed to a runner.
  const response = await fetch(`${vaultAddr}/v1/sys/health`, {
    headers: { "X-Vault-Token": requireEnv("VAULT_TOKEN") },
  });
  return {
    ok: response.ok || response.status === 429 || response.status === 472,
    status: response.status,
  };
}

export async function createApp() {
  const pool = getProductionPool();
  await runMigrationsAsOwner();
  // P2B: the secret-store backend is selected by TANREN_SECRET_STORE
  // (default `vault`, so existing deployments are unchanged). See
  // engine/contracts/secretStoreFactory.ts.
  const runnerSecrets = buildSecretStore();
  await seedRunnerIdentitySecret(runnerSecrets);
  return buildApp({
    pool,
    secrets: runnerSecrets,
    auth: buildAuthFromEnv(pool, port),
    // P3-0029: wrap the SSH substrate so every runner command emits a boundary
    // timing record. Behavior is unchanged; this only measures. The per-run
    // draft-PR route pushes the runner workspace branch over this substrate.
    ssh: new TimedSshSubstrate(new Ssh2Substrate(runnerSecrets)),
  });
}

export function buildApp(input: {
  pool: pg.Pool;
  ssh: SshSubstrate;
  secrets?: SecretStore;
  githubHttp?: GitHubHttpClient;
  runnerIdentitySecretRef?: string;
  vaultHealthCheck?: () => Promise<{ ok: boolean; status: number }>;
  auth?: BuildAppAuthOptions;
  credentialRegistry?: CredentialRegistry;
}) {
  const app = new Hono<ActorContextEnv>();
  // The SecretStore MUST be injected explicitly (createApp builds it from
  // TANREN_SECRET_STORE; tests inject an explicit InMemorySecretStore fixture).
  // There is NO silent in-memory default — a misconfigured deploy fails fast
  // rather than running on an ephemeral store that loses credentials on restart.
  if (input.secrets === undefined) {
    throw new Error("buildApp requires an explicit SecretStore (set TANREN_SECRET_STORE; tests inject a memory store)");
  }
  const secrets = input.secrets;
  // P3-0029: wrap the GitHub HTTP client so every API round trip emits a
  // boundary timing record (with method, path template, status, 429 flag).
  const githubHttp = new TimedGitHubHttpClient(input.githubHttp ?? new FetchGitHubHttpClient());
  // P2·0: the run/merge lifecycle's VCS/CI operations route through the
  // VcsProvider seam (the registry default is the real GitHub impl, composing
  // `githubHttp`). The forge-recon / config-gate / notifications GitHub code
  // keeps using `githubHttp` directly — only the run+merge path uses the seam.
  const vcsProvider = buildVcsProvider(githubHttp);
  const identitySecretRef = input.runnerIdentitySecretRef ?? runnerIdentitySecretRef;
  const vaultHealthCheck = input.vaultHealthCheck ?? vaultHealth;
  // P3-0003: one shared minter so installation-token caching spans routes.
  const githubAppMinter = new GithubAppTokenMinter({ secrets });

  if (input.auth !== undefined) {
    app.route(
      "/auth",
      createAuthRoutes({
        providers: input.auth.providers,
        store: input.auth.store,
        publicBaseUrl: input.auth.publicBaseUrl,
        cookieSecure: input.auth.cookieSecure,
      }),
    );
    app.use(
      "*",
      createAuthMiddleware({
        store: input.auth.store,
        platformAdminUserIds: input.auth.platformAdminUserIds,
        localDevActor: input.auth.localDevActor,
        // RLS HTTP-route scoping: the resource→org resolver looks up the addressed
        // spec/run/project's org on the BYPASSRLS system pool so the resource-keyed
        // root shapes establish a per-request org scope.
        pool: input.pool,
      }),
    );
  }

  // Durable credential registry: records persist in the SAME SecretStore as the
  // credential values (under `credregistry/...`), so the credential LIST survives
  // an orchestrator restart.
  const credentialRegistry = input.credentialRegistry ?? new SecretStoreCredentialRegistry(secrets);

  // P3-0017: audit-gate GitHub port factory. Mints the org's App token (or the
  // static fallback) so a Bucket-B write opens a PR in `tanren-config`. Injectable.
  const configGateGithub: ConfigGateGithubFactory = async (orgId) => {
    const installation = await loadOrgGithubAppInstallation(input.pool, orgId);
    const resolved = await resolveGithubToken({ secrets, installation, minter: githubAppMinter });
    return new FetchConfigGateGitHub({
      http: githubHttp,
      token: resolved.token,
      refreshToken: resolved.refresh,
    });
  };
  // Live benchmark infra: the benchmark scheduler (the experiments `/run` route)
  // runs in THIS API process, so its real accept + await seams need the same
  // allocator/SSH the run path uses plus the shared LISTEN connection. The
  // allocator is built from env (same factory as the worker boot); the SSH +
  // identity ref come from the injected substrate. A single PgNotifyListener
  // (held off `input.pool`, the SAME `tanren_run` channel the SSE source uses)
  // drives the LISTEN/NOTIFY terminal await.
  // One allocator shared by the benchmark scheduler AND the Forge answerer
  // factories (each allocates a short-lived runner per model call).
  const allocator = buildAllocatorFromEnv(input.pool, secrets);
  const benchmark = {
    allocator,
    ssh: input.ssh,
    identitySecretRef,
    notifyListener: new PgNotifyListener(input.pool),
  };
  // The full feature-route mount table lives in `mountFeatureRoutes` — the long
  // declarative list of create*Routes registrations, in the same order, with the
  // shared deps assembled above. Behavior is identical to the prior inline block.
  mountFeatureRoutes(app, {
    pool: input.pool,
    secrets,
    githubHttp,
    vcsProvider,
    githubAppMinter,
    credentialRegistry,
    configGateGithub,
    vaultHealthCheck,
    // The Forge answerer factories allocate a runner per model call; they share
    // the run worker's allocator / SSH substrate / identity ref.
    allocator,
    ssh: input.ssh,
    identitySecretRef,
    benchmark,
  });

  app.get("/healthz", async (c) => {
    const dbResult = await input.pool.query("SELECT 1 AS ok");
    const vault = await vaultHealthCheck();
    return c.json({
      service: "orchestrator",
      ok: dbResult.rows[0]?.ok === 1 && vault.ok,
      database: "ok",
      vault,
    });
  });

  app.get("/version", (c) =>
    c.json({ service: "orchestrator", version: process.env["npm_package_version"] ?? "0.0.0" }),
  );

  // The Phase-1 root API endpoints (project/spec creation, credential + auth-
  // bundle imports, per-run draft-PR / CI-poll, the legacy `/runs/:runId` read)
  // live in `mountRootApiRoutes`. Behavior is identical.
  mountRootApiRoutes(app, {
    pool: input.pool,
    secrets,
    vcsProvider,
    githubAppMinter,
    identitySecretRef,
    ssh: input.ssh,
  });

  return app;
}

function getProductionPool(): pg.Pool {
  productionPool ??= createDbPool();
  return productionPool;
}

/**
 * RLS R3b: run migrations as the OWNER, not the runtime role. After the
 * enforcement flip the runtime `DATABASE_URL` connects as the restricted
 * `tanren_app` role (NOBYPASSRLS, no DDL grants), so it CANNOT run CREATE/ALTER
 * TABLE. Migrations therefore use a dedicated owner connection
 * (MIGRATION_DATABASE_URL), opened only for the migrate step and closed
 * immediately. When MIGRATION_DATABASE_URL is unset (single-role dev / no flip)
 * we fall back to the runtime pool — behavior-identical to before R3b.
 */
async function runMigrationsAsOwner(): Promise<void> {
  const ownerUrl = process.env["MIGRATION_DATABASE_URL"];
  if (ownerUrl === undefined || ownerUrl === "") {
    await migrate(getProductionPool());
    return;
  }
  const ownerPool = createDbPool(ownerUrl);
  try {
    await migrate(ownerPool);
  } finally {
    await ownerPool.end();
  }
}

async function seedRunnerIdentitySecret(secrets: SecretStore): Promise<void> {
  const inlinePrivateKey = process.env["TANREN_RUNNER_IDENTITY_PRIVATE_KEY"];
  if (inlinePrivateKey !== undefined && inlinePrivateKey !== "") {
    await secrets.put({ ref: runnerIdentitySecretRef, value: inlinePrivateKey });
    return;
  }

  const keyPath = process.env["TANREN_RUNNER_IDENTITY_KEY_PATH"];
  if (keyPath !== undefined && keyPath !== "") {
    await secrets.put({ ref: runnerIdentitySecretRef, value: await readFile(keyPath, "utf8") });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await createApp();
  serve({ fetch: app.fetch, port });
  console.log(`orchestrator listening on :${port}`);
  // Plane-split P2: the control-plane INTERNAL mTLS listener (separate HTTPS
  // server) serving `/internal/claim-job` — the same atomic CAS, transport
  // behind mTLS. Starts only when TANREN_INTERNAL_TLS_* are set (see internalServer.ts).
  startInternalMtlsServer({ pool: getProductionPool() });
  // P3-0001 / plane-split P1: the run worker dequeues `plan` jobs. It is now a
  // STANDALONE deployable (`worker-main.ts`, the `worker` service); the API runs
  // it in-process ONLY as a single-process dev convenience (TANREN_RUN_WORKER=1),
  // sharing the same `bootRunWorker` construction as the standalone entrypoint.
  if (runWorkerEnabled()) {
    await bootRunWorker();
    console.log("run worker started (in-process)");
  }
}
