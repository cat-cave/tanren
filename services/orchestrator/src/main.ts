import { readFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { createDbPool, getSystemPool, migrate } from "@tanren/db";
import { Hono } from "hono";
import type pg from "pg";
import { buildAuthFromEnv, type BuildAppAuthOptions } from "./mainAuth.js";
import { buildAllocatorFromEnv } from "./engine/allocators/index.js";
import { buildSecretStore, InMemorySecretStore, type SecretStore } from "./engine/contracts/index.js";
import { FetchGitHubHttpClient, type GitHubHttpClient } from "./engine/providers/github.js";
import { GithubAppTokenMinter } from "./engine/providers/githubAppTokenMinter.js";
import { FetchConfigGateGitHub } from "./engine/config/configGateGithub.js";
import { loadOrgGithubAppInstallation } from "./engine/credentials/orgGithubApp.js";
import { resolveGithubToken } from "./engine/credentials/githubTokenResolver.js";
import type { ConfigGateGithubFactory } from "./routes/orgs/index.js";
import { TimedGitHubHttpClient, TimedSshSubstrate } from "./engine/observability/index.js";
import { Ssh2Substrate } from "./engine/ssh/index.js";
import { bootRunWorker, runWorkerEnabled } from "./engine/worker/index.js";
import { startInternalMtlsServer } from "./internalServer.js";
import type { runHelloWorkflow } from "./engine/workflow/helloRun.js";
import { createAuthMiddleware, type ActorContextEnv } from "./middleware/auth.js";
import { createAuthRoutes } from "./routes/auth/index.js";
import { SecretStoreCredentialRegistry, type CredentialRegistry } from "./routes/credentials/index.js";
import { mountFeatureRoutes } from "./mountFeatureRoutes.js";
import { mountRootApiRoutes } from "./mountRootApiRoutes.js";

export { buildAuthFromEnv, type BuildAppAuthOptions } from "./mainAuth.js";

const port = Number(process.env["ORCHESTRATOR_PORT"] ?? 3100);
const vaultAddr = process.env["VAULT_ADDR"] ?? "http://localhost:8200";
const vaultToken = process.env["VAULT_TOKEN"] ?? "dev-root-token";
const runnerIdentitySecretRef = process.env["TANREN_RUNNER_IDENTITY_SECRET_REF"] ?? "runner/local-docker/identity";
let productionPool: pg.Pool | undefined;

async function vaultHealth() {
  const response = await fetch(`${vaultAddr}/v1/sys/health`, {
    headers: { "X-Vault-Token": vaultToken },
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
    helloDependencies: {
      // RLS R3b: the hello fixture is cross-org system seeding, so its allocator's
      // runner writes go through the BYPASSRLS `tanren_system` pool (matching the
      // fixture pool `/hello/run` hands runHelloWorkflow); else the runtime pool.
      allocator: buildAllocatorFromEnv(getSystemPool() ?? pool),
      // P3-0029: wrap the SSH substrate so every runner command emits a
      // boundary timing record. Behavior is unchanged; this only measures.
      ssh: new TimedSshSubstrate(new Ssh2Substrate(runnerSecrets)),
      identitySecretRef: runnerIdentitySecretRef,
    },
  });
}

export function buildApp(input: {
  pool: pg.Pool;
  helloDependencies: Parameters<typeof runHelloWorkflow>[1];
  secrets?: SecretStore;
  githubHttp?: GitHubHttpClient;
  runnerIdentitySecretRef?: string;
  vaultHealthCheck?: () => Promise<{ ok: boolean; status: number }>;
  auth?: BuildAppAuthOptions;
  credentialRegistry?: CredentialRegistry;
}) {
  const app = new Hono<ActorContextEnv>();
  const secrets = input.secrets ?? new InMemorySecretStore();
  // P3-0029: wrap the GitHub HTTP client so every API round trip emits a
  // boundary timing record (with method, path template, status, 429 flag).
  const githubHttp = new TimedGitHubHttpClient(input.githubHttp ?? new FetchGitHubHttpClient());
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
  // The full feature-route mount table lives in `mountFeatureRoutes` — the long
  // declarative list of create*Routes registrations, in the same order, with the
  // shared deps assembled above. Behavior is identical to the prior inline block.
  mountFeatureRoutes(app, {
    pool: input.pool,
    secrets,
    githubHttp,
    githubAppMinter,
    credentialRegistry,
    configGateGithub,
    vaultHealthCheck,
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
  // bundle imports, the hello trigger, per-run draft-PR / CI-poll, the legacy
  // `/runs/:runId` read) live in `mountRootApiRoutes`. Behavior is identical.
  mountRootApiRoutes(app, {
    pool: input.pool,
    secrets,
    githubHttp,
    githubAppMinter,
    identitySecretRef,
    helloDependencies: input.helloDependencies,
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
