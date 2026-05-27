import { serve } from "@hono/node-server";
import { createDbPool, migrate } from "@tanren/db";
import { createAllocatorApi } from "./api.js";
import { HttpDockerEngineClient } from "./dockerEngine.js";
import { PgRunnerStore } from "./pgRunnerStore.js";
import { RunnerLifecycle } from "./runnerLifecycle.js";
import { AbandonedRunSweeper } from "./sweeper.js";
import { VaultSecretsClient } from "./vaultSecrets.js";

const port = Number(process.env.ALLOCATOR_PORT ?? 3200);
const authToken = process.env.TANREN_ALLOCATOR_TOKEN ?? "dev";
const maxRunHours = Number(process.env.TANREN_MAX_RUN_HOURS ?? 6);
const networkName = process.env.TANREN_ALLOCATOR_NETWORK ?? "tanren_default";
const hostSshPortEnv = process.env.TANREN_ALLOCATOR_HOST_SSH_PORT;
const sshHostnameTemplate = process.env.TANREN_ALLOCATOR_SSH_HOSTNAME_TEMPLATE ?? "{container}";
const sweeperIntervalMs = Number(process.env.TANREN_ALLOCATOR_SWEEPER_INTERVAL_MS ?? 60_000);

async function main(): Promise<void> {
  const docker = new HttpDockerEngineClient();
  const pool = createDbPool();
  await migrate(pool);
  const store = new PgRunnerStore(pool);
  const secrets = new VaultSecretsClient({
    addr: process.env.VAULT_ADDR ?? "http://vault:8200",
    token: process.env.VAULT_TOKEN ?? "dev-root-token"
  });

  const lifecycle = new RunnerLifecycle({
    docker,
    store,
    secrets,
    networkName,
    hostSshPort: hostSshPortEnv === undefined || hostSshPortEnv === "" ? undefined : Number(hostSshPortEnv),
    sshHostnameForOrchestrator: (container) => sshHostnameTemplate.replace("{container}", container),
    capAdd: (process.env.TANREN_RUNNER_CAP_ADD ?? "SYS_ADMIN").split(",").filter((part) => part !== ""),
    securityOpt: (process.env.TANREN_RUNNER_SECURITY_OPT ?? "apparmor=unconfined,seccomp=unconfined").split(",").filter((part) => part !== "")
  });

  const sweeper = new AbandonedRunSweeper({
    lifecycle,
    maxRunHours,
    intervalMs: sweeperIntervalMs
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
        return error instanceof Error && /status (?:404|400|500)/.test(error.message);
      }
    }
  });

  serve({ fetch: app.fetch, port });
  console.log(`allocator listening on :${port}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
