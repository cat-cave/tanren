// Plane B resolution: turn a project's `project_app_env` entries into the env map
// `{ KEY: value }` the built product gets at a given phase (dev | test | runtime |
// build). Only entries whose `scopes` INCLUDE the requested phase are materialized
// — a `dev`-only entry never reaches CI/runtime. Secret entries (`valueRef`) are
// read from the secret manager (the SecretStore seam); non-secret entries
// (`plainValue`) are inlined.
//
// SECURITY: the returned values are SECRET — callers must never log/emit them.
// This module reads them ONLY to build the env map; it logs nothing. The reads run
// org-scoped (the caller hands an org-scope-carrying `QueryClient`), so RLS gates
// which project's entries are even visible.

import type pg from "pg";
import type { ActorRef } from "../state/actor.js";
import type { SecretStore } from "../contracts/secretStore.js";
import { AppEnvironmentStore, type AppEnvScope } from "../repositories/appEnvironment.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

export interface ResolveAppEnvInput {
  client: QueryClient;
  secrets: SecretStore;
  projectId: string;
  scope: AppEnvScope;
  actor: ActorRef;
}

/**
 * Resolve the app-env map for one phase. Reads the project's `project_app_env`
 * entries (org-scoped via `client`), keeps only those whose `scopes` include
 * `scope`, and produces `{ KEY: value }` — secret entries resolved from the
 * SecretStore via their `valueRef`, plain entries inlined. A secret ref that the
 * manager cannot resolve fails LOUDLY (a misconfigured app secret must not
 * silently yield an empty value).
 *
 * The returned map holds SECRET values — never log/emit it.
 */
export async function resolveAppEnvForScope(input: ResolveAppEnvInput): Promise<Record<string, string>> {
  const entries = await AppEnvironmentStore.list(input.client, input.projectId, input.actor);
  const inScope = entries.filter((entry) => entry.scopes.includes(input.scope));

  const env: Record<string, string> = {};
  for (const entry of inScope) {
    if (entry.plainValue !== null) {
      env[entry.key] = entry.plainValue;
      continue;
    }
    // valueRef is set (the DB CHECK guarantees XOR with plainValue). Resolve the
    // secret from the manager — never the value from the DB.
    if (entry.valueRef === null) {
      throw new Error(`project_app_env entry '${entry.key}' has neither a plain value nor a secret ref`);
    }
    const secret = await input.secrets.get(entry.valueRef);
    if (secret === undefined) {
      throw new Error(`project_app_env entry '${entry.key}' references unresolved secret ref '${entry.valueRef}'`);
    }
    env[entry.key] = secret.value;
  }
  return env;
}
