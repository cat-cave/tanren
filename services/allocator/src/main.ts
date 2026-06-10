import { serve } from "@hono/node-server";
import { createDbPool, migrate } from "@tanren/db";
import { createAllocatorApi } from "./api.js";
import { HttpDockerEngineClient } from "./dockerEngine.js";
import { PgRunnerStore } from "./pgRunnerStore.js";
import { RunnerLifecycle } from "./runnerLifecycle.js";
import { AbandonedRunSweeper } from "./sweeper.js";
import { requireEnv } from "./requireEnv.js";
import { parsedEnv } from "./envSchema.js";

// Boot-validated env (Zod, fail-loud at load — see envSchema.ts). These replace
// the prior per-site `Number(process.env[...] ?? n)` reads. TANREN_MAX_RUN_HOURS
// is resolved through the reaper-safe `requirePositiveHours` helper inside the
// schema (fall back loud, never crash on a bad reaper threshold).
const port = parsedEnv.ALLOCATOR_PORT;
// The bearer token gating `/allocate` + `/release` is REQUIRED — no `"dev"`
// fallback (the surviving sibling of the removed `dev-root-token`). The compose
// stacks set it (dev: `dev`; prod: required via `:?`); a blank/unset value fails
// hard rather than silently accepting `Bearer dev`. Required-missing → loud, so
// it stays on the `requireEnv` guard rather than the schema's optional fields.
const authToken = requireEnv("TANREN_ALLOCATOR_TOKEN");
const maxRunHours = parsedEnv.TANREN_MAX_RUN_HOURS;
const networkName = parsedEnv.TANREN_ALLOCATOR_NETWORK;
const hostSshPort = parsedEnv.TANREN_ALLOCATOR_HOST_SSH_PORT;
const sshHostnameTemplate = parsedEnv.TANREN_ALLOCATOR_SSH_HOSTNAME_TEMPLATE;
const sweeperIntervalMs = parsedEnv.TANREN_ALLOCATOR_SWEEPER_INTERVAL_MS;

async function main(): Promise<void> {
  const docker = new HttpDockerEngineClient();
  // RLS R3b: migrations run as the OWNER (MIGRATION_DATABASE_URL when set, else
  // the runtime URL for single-role dev). The allocator runs TWO runtime pools:
  //  - the SYSTEM pool (TANREN_SYSTEM_DATABASE_URL, the BYPASSRLS `tanren_system`
  //    role) for genuinely cross-org work — the abandoned-runner sweep/reap and
  //    the runner_id-keyed `/release` (no org context), which must see every
  //    tenant's `runners` rows; and
  //  - a RESTRICTED app-role pool (DATABASE_URL) used ONLY through
  //    `runWithOrgScope` for the per-run `runners` INSERT, so that TENANT row is
  //    written WITHIN RLS (de-priv), not off-RLS via the system role.
  // TANREN_SYSTEM_DATABASE_URL is REQUIRED (both compose profiles set it): the
  // system pool MUST be the BYPASSRLS `tanren_system` role, never a silent
  // collapse onto the tenant runtime DATABASE_URL — a cross-org sweep/reap on the
  // NOBYPASSRLS app role would see ZERO `runners` rows under enforced policies. We
  // fail loud here rather than `|| DATABASE_URL`.
  await runAllocatorMigrations();
  const systemPool = createDbPool(requireEnv("TANREN_SYSTEM_DATABASE_URL"));
  const appPool = createDbPool(process.env["DATABASE_URL"]);
  const store = new PgRunnerStore(systemPool, appPool);

  // The allocator has NO secret-store access: it never resolves a secret VALUE.
  // Run-scoped runner credentials are delivered to the runner over the SSH FILE
  // substrate by the orchestrator AFTER allocation (codexMaterializer), so the
  // allocator only creates/destroys containers + persists the `runners` row. The
  // old VAULT_TOKEN-backed CODEX_HOME env-bundle channel is removed.
  const lifecycle = new RunnerLifecycle({
    docker,
    store,
    networkName,
    hostSshPort,
    sshHostnameForOrchestrator: (container) => sshHostnameTemplate.replace("{container}", container),
    capAdd: parsedEnv.TANREN_RUNNER_CAP_ADD.split(",").filter((part) => part !== ""),
    securityOpt: parsedEnv.TANREN_RUNNER_SECURITY_OPT.split(",").filter((part) => part !== ""),
  });

  const sweeper = new AbandonedRunSweeper({
    lifecycle,
    maxRunHours,
    intervalMs: sweeperIntervalMs,
  });
  sweeper.start();

  const app = createAllocatorApi({
    lifecycle,
    authToken,
    dockerPing: async () => {
      try {
        await docker.inspectContainer("00000000-allocator-self-check");
        return true;
      } catch (error) {
        // Any HTTP response — even 404 — proves the daemon is reachable.
        return error instanceof Error && /status (?:404|400|500)/u.test(error.message);
      }
    },
  });

  serve({ fetch: app.fetch, port });
  console.log(`allocator listening on :${port}`);
}

/**
 * Run migrations as the table OWNER, closing the pool after.
 *
 * No-silent-fallback doctrine: `MIGRATION_DATABASE_URL` is REQUIRED (both compose
 * profiles set it). A missing value used to silently fall back to the runtime
 * pool — which under R3b is the restricted `tanren_app` role that cannot run DDL,
 * so the fallback would fail the migration obscurely anyway. We fail LOUD up
 * front instead, mirroring the orchestrator (services/orchestrator/src/main.ts).
 */
async function runAllocatorMigrations(): Promise<void> {
  const ownerUrl = requireEnv("MIGRATION_DATABASE_URL");
  const ownerPool = createDbPool(ownerUrl);
  try {
    await migrate(ownerPool);
  } finally {
    await ownerPool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
