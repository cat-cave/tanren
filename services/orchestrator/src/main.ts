import { readFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { createDbPool, migrate } from "@tanren/db";
import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext, IdentityProviderId } from "./auth/index.js";
import { buildOidcProviderFromEnv, createDevLoginProvider, GitHubOAuthProvider, IdentityStore, type IdentityProvider } from "./auth/index.js";
import { PgRunnerStore, SidecarHttpAllocator, StaticRunnerAllocator } from "./engine/allocators/index.js";
import type { Allocator } from "./engine/contracts/allocator.js";
import { InMemorySecretStore, type SecretStore, VaultSecretStore } from "./engine/contracts/index.js";
import { parseRawViewOptIn, redactEventRows } from "./routes/runs/redaction.js";
import { storeGithubToken } from "./engine/credentials/githubToken.js";
import { FetchGitHubHttpClient, type GitHubHttpClient } from "./engine/providers/github.js";
import { GithubAppTokenMinter } from "./engine/providers/githubAppTokenMinter.js";
import { mountGithubAppInstallFromEnv } from "./routes/auth/githubAppInstall.js";
import { TimedGitHubHttpClient, TimedSshSubstrate } from "./engine/observability/index.js";
import { Ssh2Substrate } from "./engine/ssh/index.js";
import { runWorkerEnabled, startRunWorker } from "./engine/worker/index.js";
import { CiPullRequestNotFoundError, CiRunNotFoundError, pollCiForRun } from "./engine/workflow/ciPolling.js";
import { DraftPrRunnerNotFoundError, DraftPrRunNotFoundError, publishDraftPullRequestForRun } from "./engine/workflow/githubDraftPr.js";
import { runHelloWorkflow } from "./engine/workflow/helloRun.js";
import {
  createProject, createQueuedRunFromSpec, createSpec, ProjectAccessDeniedError,
  ProjectNotFoundError, SpecDependenciesBlockedError, SpecNotRunnableError, SpecNotFoundError
} from "./engine/workflow/projectSpec.js";
import { createAuthMiddleware, type ActorContextEnv } from "./middleware/auth.js";
import { createAuthRoutes } from "./routes/auth/index.js";
import { createBehaviorRoutes } from "./routes/behaviors/index.js";
import { createBrownfieldRoutes } from "./routes/brownfield/index.js";
import { registerAuthBundleImportRoutes } from "./routes/credentials/authBundleImports.js";
import { createCredentialRoutes, InMemoryCredentialRegistry, type CredentialRegistry } from "./routes/credentials/index.js";
import { createDoctorRoutes } from "./routes/doctor/index.js";
import { createDoraRoutes } from "./routes/dora/index.js";
import { createForgeRoutes } from "./routes/forge/index.js";
import { createInsightRoutes } from "./routes/insights/index.js";
import { createMilestoneRoutes } from "./routes/milestones/index.js";
import { createNotificationRoutes } from "./routes/notifications/index.js";
import { createOrgRoutes } from "./routes/orgs/index.js";
import { createPersonaRoutes } from "./routes/personas/index.js";
import { createProjectRoutes } from "./routes/projects/index.js";
import { createRecoveryRoutes } from "./routes/recovery/index.js";
import { createRunRoutes } from "./routes/runs/index.js";
import { createSpecRoutes } from "./routes/specs/index.js";

const port = Number(process.env.ORCHESTRATOR_PORT ?? 3100);
const vaultAddr = process.env.VAULT_ADDR ?? "http://localhost:8200";
const vaultToken = process.env.VAULT_TOKEN ?? "dev-root-token";
const runnerIdentitySecretRef = process.env.TANREN_RUNNER_IDENTITY_SECRET_REF ?? "runner/local-docker/identity";
let productionPool: pg.Pool | undefined;

const projectInputSchema = z.object({
  name: z.string().min(1),
  repoUrl: z.string().min(1),
  defaultBranch: z.string().min(1).optional(),
  runnerImage: z.string().min(1).optional(),
  allocator: z.string().min(1).optional(),
  config: z.record(z.string(), z.unknown()).optional()
});

const specInputSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  dependsOn: z.array(z.string().min(1)).optional()
});

const runInputSchema = z.object({
  trigger: z.enum(["cli", "dashboard", "api", "webhook"]).optional(),
  branch: z.string().min(1).optional()
});

const githubCredentialImportSchema = z.object({
  ref: z.string().min(1),
  token: z.string().min(1)
});

const draftPrInputSchema = z.object({
  githubCredentialRef: z.string().min(1).optional(),
  workspacePath: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  body: z.string().optional(),
  timeoutMs: z.number().int().positive().optional()
});

const ciPollInputSchema = z.object({
  githubCredentialRef: z.string().min(1).optional()
});

async function vaultHealth() {
  const response = await fetch(`${vaultAddr}/v1/sys/health`, {
    headers: { "X-Vault-Token": vaultToken }
  });
  return { ok: response.ok || response.status === 429 || response.status === 472, status: response.status };
}

export async function createApp() {
  const pool = getProductionPool();
  await migrate(pool);
  const runnerSecrets = new VaultSecretStore({ addr: vaultAddr, token: vaultToken });
  await seedRunnerIdentitySecret(runnerSecrets);
  return buildApp({
    pool,
    secrets: runnerSecrets,
    auth: buildAuthFromEnv(pool),
    helloDependencies: {
      allocator: buildAllocatorFromEnv(pool),
      // P3-0029: wrap the SSH substrate so every runner command emits a
      // boundary timing record. Behavior is unchanged; this only measures.
      ssh: new TimedSshSubstrate(new Ssh2Substrate(runnerSecrets)),
      identitySecretRef: runnerIdentitySecretRef
    }
  });
}

function buildAllocatorFromEnv(pool: pg.Pool): Allocator {
  const runners = new PgRunnerStore(pool);
  const kind = (process.env.TANREN_ALLOCATOR_KIND ?? "sidecar").toLowerCase();
  if (kind === "static") {
    // Dev-only: route to the long-lived dev compose static runner. Preserves
    // the P2A-0010 security boundary (no docker socket on orchestrator) while
    // keeping `just smoke` working. See docs/operator-guide/runners.md.
    return new StaticRunnerAllocator({
      host: process.env.TANREN_RUNNER_SSH_HOST ?? "runner",
      port: Number(process.env.TANREN_RUNNER_SSH_PORT ?? 22),
      username: process.env.TANREN_RUNNER_SSH_USER ?? "tanren",
      hostKeyFingerprint:
        process.env.TANREN_RUNNER_SSH_HOST_FINGERPRINT === undefined ||
        process.env.TANREN_RUNNER_SSH_HOST_FINGERPRINT === ""
          ? undefined
          : process.env.TANREN_RUNNER_SSH_HOST_FINGERPRINT,
      runners
    });
  }
  return new SidecarHttpAllocator({
    baseUrl: process.env.TANREN_ALLOCATOR_URL ?? "http://allocator:3200",
    authToken: process.env.TANREN_ALLOCATOR_TOKEN ?? "dev",
    runners
  });
}

export interface BuildAppAuthOptions {
  store: IdentityStore;
  providers: Map<IdentityProviderId, IdentityProvider>;
  publicBaseUrl: string;
  cookieSecure?: boolean;
  platformAdminUserIds?: ReadonlySet<string>;
  /** When set, requests without a session/token resolve to this actor. Used in tests/dev. */
  localDevActor?: ActorContext;
}

export function buildAuthFromEnv(pool: pg.Pool): BuildAppAuthOptions | undefined {
  const clientId = process.env.TANREN_GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = process.env.TANREN_GITHUB_OAUTH_CLIENT_SECRET;
  const publicBaseUrl = process.env.TANREN_PUBLIC_BASE_URL ?? `http://localhost:${port}`;
  const providers = new Map<IdentityProviderId, IdentityProvider>();
  if (clientId !== undefined && clientId !== "" && clientSecret !== undefined && clientSecret !== "") {
    providers.set("github_oauth", new GitHubOAuthProvider({ clientId, clientSecret }));
  }
  // P3-0030: Authentik (or any OIDC IdP) as a second identity provider. Additive
  // and opt-in: registers only when issuer + client id/secret are all set, so
  // github_oauth/local_dev behavior is unchanged when the OIDC env is absent.
  const oidc = buildOidcProviderFromEnv();
  if (oidc !== undefined) {
    providers.set("oidc", oidc);
  }
  // DEV-ONLY escape hatch. Opt-in via TANREN_DEV_LOGIN=1 (set only in
  // compose.dev.yml — compose.prod.yml MUST never set it). When enabled it
  // registers a LocalDevProvider so `/auth/login?provider=local_dev` mints a
  // real session against the synthetic dev org, unblocking manual UI testing
  // without a registered GitHub OAuth app. Defaults off → byte-for-byte
  // unchanged behavior. Refused (with a loud warning, flag ignored) under a
  // prod-like cookie-secure context as a defense-in-depth guard.
  if (process.env.TANREN_DEV_LOGIN === "1") {
    if (process.env.TANREN_COOKIE_SECURE === "1") {
      console.warn(
        "[auth] TANREN_DEV_LOGIN=1 ignored: refusing dev-login escape hatch under TANREN_COOKIE_SECURE=1 (prod-like context)"
      );
    } else {
      providers.set("local_dev", createDevLoginProvider());
    }
  }
  if (providers.size === 0) {
    return undefined;
  }
  return {
    store: new IdentityStore(pool),
    providers,
    publicBaseUrl,
    cookieSecure: process.env.TANREN_COOKIE_SECURE === "1"
  };
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
        cookieSecure: input.auth.cookieSecure
      })
    );
    app.use(
      "*",
      createAuthMiddleware({
        store: input.auth.store,
        platformAdminUserIds: input.auth.platformAdminUserIds,
        localDevActor: input.auth.localDevActor
      })
    );
  }

  const credentialRegistry = input.credentialRegistry ?? new InMemoryCredentialRegistry();

  app.route("/orgs", createOrgRoutes({ pool: input.pool }));
  app.route("/orgs", createProjectRoutes({ pool: input.pool }));
  app.route("/orgs", createSpecRoutes({ pool: input.pool }));
  app.route("/orgs", createPersonaRoutes({ pool: input.pool }));
  app.route("/orgs", createBehaviorRoutes({ pool: input.pool }));
  app.route("/orgs", createMilestoneRoutes({ pool: input.pool }));
  app.route("/orgs", createBrownfieldRoutes({ pool: input.pool, secrets, githubHttp, githubAppMinter }));
  // P3-0003: GitHub App install flow; mounts only when configured via env.
  mountGithubAppInstallFromEnv(app, { pool: input.pool, secrets, minter: githubAppMinter });
  app.route("/orgs", createForgeRoutes({ pool: input.pool, secrets, githubHttp }));
  app.route("/orgs", createInsightRoutes({ pool: input.pool }));
  app.route("/orgs", createDoraRoutes({ pool: input.pool }));
  app.route("/orgs", createNotificationRoutes({ pool: input.pool }));
  app.route("/orgs", createRunRoutes({ pool: input.pool }));
  app.route("/orgs", createRecoveryRoutes({ pool: input.pool }));
  app.route(
    "/",
    createCredentialRoutes({ pool: input.pool, secrets, registry: credentialRegistry })
  );
  app.route(
    "/",
    createDoctorRoutes({
      pool: input.pool,
      secrets,
      vaultHealthCheck
    })
  );

  app.get("/healthz", async (c) => {
    const dbResult = await input.pool.query("SELECT 1 AS ok");
    const vault = await vaultHealthCheck();
    return c.json({
      service: "orchestrator",
      ok: dbResult.rows[0]?.ok === 1 && vault.ok,
      database: "ok",
      vault
    });
  });

  app.get("/version", (c) => c.json({ service: "orchestrator", version: process.env.npm_package_version ?? "0.0.0" }));

  app.post("/projects", async (c) => {
    const parsed = projectInputSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_project", issues: parsed.error.issues }, 400);
    }
    return c.json(await createProject(input.pool, parsed.data, actorOf(c)), 201);
  });

  app.post("/specs", async (c) => {
    const parsed = specInputSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_spec", issues: parsed.error.issues }, 400);
    }
    try {
      return c.json(await createSpec(input.pool, parsed.data, actorOf(c)), 201);
    } catch (error) {
      if (error instanceof ProjectNotFoundError) {
        return c.json({ error: "project_not_found", message: error.message }, 404);
      }
      if (error instanceof ProjectAccessDeniedError) {
        return c.json({ error: "project_access_denied", message: error.message }, 403);
      }
      if (error instanceof SpecNotFoundError) {
        return c.json({ error: "spec_dependency_not_found", message: error.message }, 404);
      }
      throw error;
    }
  });

  app.post("/specs/:specId/runs", async (c) => {
    const parsed = runInputSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "invalid_run", issues: parsed.error.issues }, 400);
    }
    try {
      return c.json(
        await createQueuedRunFromSpec(
          input.pool,
          { specId: c.req.param("specId"), ...parsed.data },
          actorOf(c)
        ),
        201
      );
    } catch (error) {
      if (error instanceof SpecNotFoundError) {
        return c.json({ error: "spec_not_found", message: error.message }, 404);
      }
      if (error instanceof ProjectAccessDeniedError) {
        return c.json({ error: "project_access_denied", message: error.message }, 403);
      }
      if (error instanceof SpecDependenciesBlockedError) {
        return c.json({ error: "spec_dependencies_blocked", message: error.message }, 409);
      }
      if (error instanceof SpecNotRunnableError) {
        return c.json({ error: "spec_not_runnable", message: error.message }, 409);
      }
      throw error;
    }
  });

  // Codex (Phase 1) + Claude/opencode (P3-0012) auth-bundle import routes.
  registerAuthBundleImportRoutes(app, secrets);

  app.post("/credentials/github/import", async (c) => {
    const parsed = githubCredentialImportSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_github_credential", issues: parsed.error.issues }, 400);
    }
    try {
      return c.json(await storeGithubToken(secrets, parsed.data), 201);
    } catch (error) {
      return c.json({ error: "invalid_github_credential", message: messageFromError(error) }, 400);
    }
  });

  app.post("/hello/run", async (c) => {
    const summary = await runHelloWorkflow(input.pool, input.helloDependencies);
    return c.json(summary, 201);
  });

  app.post("/runs/:runId/github/draft-pr", async (c) => {
    const parsed = draftPrInputSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "invalid_draft_pr", issues: parsed.error.issues }, 400);
    }
    try {
      return c.json(
        await publishDraftPullRequestForRun({
          pool: input.pool,
          secrets,
          githubHttp,
          ssh: input.helloDependencies.ssh,
          runId: c.req.param("runId"),
          identitySecretRef,
          timeoutMs: parsed.data.timeoutMs ?? 30_000,
          githubAppMinter,
          ...parsed.data
        }),
        201
      );
    } catch (error) {
      if (error instanceof DraftPrRunNotFoundError) {
        return c.json({ error: "run_not_found", message: error.message }, 404);
      }
      if (error instanceof DraftPrRunnerNotFoundError) {
        return c.json({ error: "runner_not_found", message: error.message }, 409);
      }
      return c.json({ error: "github_draft_pr_failed", message: messageFromError(error) }, 502);
    }
  });

  app.post("/runs/:runId/ci/poll", async (c) => {
    const parsed = ciPollInputSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "invalid_ci_poll", issues: parsed.error.issues }, 400);
    }
    try {
      return c.json(
        await pollCiForRun({
          pool: input.pool,
          secrets,
          githubHttp,
          runId: c.req.param("runId"),
          githubAppMinter,
          ...parsed.data
        }),
        200
      );
    } catch (error) {
      if (error instanceof CiRunNotFoundError) {
        return c.json({ error: "run_not_found", message: error.message }, 404);
      }
      if (error instanceof CiPullRequestNotFoundError) {
        return c.json({ error: "pull_request_not_found", message: error.message }, 409);
      }
      return c.json({ error: "ci_poll_failed", message: messageFromError(error) }, 502);
    }
  });

  app.get("/runs/:runId", async (c) => {
    const runId = c.req.param("runId");
    const run = await input.pool.query("SELECT * FROM runs WHERE run_id = $1", [runId]);
    if (run.rowCount === 0) {
      return c.json({ error: "run_not_found" }, 404);
    }

    const tasks = await input.pool.query(
      `SELECT * FROM tasks
       WHERE run_id = $1
       ORDER BY CASE kind WHEN 'plan' THEN 1 WHEN 'write' THEN 2 WHEN 'check' THEN 3 WHEN 'audit' THEN 4 WHEN 'ci' THEN 5 ELSE 99 END,
                started_at ASC NULLS FIRST,
                task_id ASC`,
      [runId]
    );
    const events = await input.pool.query("SELECT * FROM events WHERE run_id = $1 ORDER BY ts ASC, id ASC", [runId]);
    const costs = await input.pool.query("SELECT * FROM cost_records WHERE run_id = $1 ORDER BY recorded_at ASC, id ASC", [runId]);
    const { events: serializedEvents } = await redactEventRows({
      pool: input.pool,
      rows: events.rows,
      runId,
      actor: actorOf(c),
      rawView: parseRawViewOptIn(c)
    });
    return c.json({ run: run.rows[0], tasks: tasks.rows, events: serializedEvents, costs: costs.rows });
  });

  return app;
}

function getProductionPool(): pg.Pool {
  productionPool ??= createDbPool();
  return productionPool;
}

async function seedRunnerIdentitySecret(secrets: SecretStore): Promise<void> {
  const inlinePrivateKey = process.env.TANREN_RUNNER_IDENTITY_PRIVATE_KEY;
  if (inlinePrivateKey !== undefined && inlinePrivateKey !== "") {
    await secrets.put({ ref: runnerIdentitySecretRef, value: inlinePrivateKey });
    return;
  }

  const keyPath = process.env.TANREN_RUNNER_IDENTITY_KEY_PATH;
  if (keyPath !== undefined && keyPath !== "") {
    await secrets.put({ ref: runnerIdentitySecretRef, value: await readFile(keyPath, "utf8") });
  }
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function actorOf(c: { var: { actor?: ActorContext } }): ActorContext | undefined {
  return c.var.actor;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await createApp();
  serve({ fetch: app.fetch, port });
  console.log(`orchestrator listening on :${port}`);
  // P3-0001: the run worker dequeues queued `plan` jobs and runs the real
  // planner-loop workflow. OFF by default (opt in with TANREN_RUN_WORKER=1). It
  // reuses the same pool/secrets/allocator/SSH/github construction as the HTTP
  // server (migrate + identity-secret seeding already ran in createApp).
  if (runWorkerEnabled()) {
    const workerPool = getProductionPool();
    const workerSecrets = new VaultSecretStore({ addr: vaultAddr, token: vaultToken });
    startRunWorker({
      pool: workerPool,
      allocator: buildAllocatorFromEnv(workerPool),
      // P3-0029: same boundary timing wrappers as the HTTP server path. The
      // worker internals (P3-0028) are untouched — only its injected SSH /
      // GitHub clients are decorated here at the construction site.
      ssh: new TimedSshSubstrate(new Ssh2Substrate(workerSecrets)),
      secrets: workerSecrets,
      githubHttp: new TimedGitHubHttpClient(new FetchGitHubHttpClient()),
      identitySecretRef: runnerIdentitySecretRef
    });
    console.log("run worker started");
  }
}
