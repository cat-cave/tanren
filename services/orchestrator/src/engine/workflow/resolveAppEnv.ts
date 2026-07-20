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

import { z } from "zod";
import type { ActorRef } from "../state/actor.js";
import type { SecretStore } from "../contracts/secretStore.js";
import { exactSecretRef } from "../contracts/integrationSecretStore.js";
import {
  AppEnvironmentStore,
  APP_ENV_SCOPES,
  type AppEnvEntry,
  type AppEnvironment,
  type AppEnvScope,
} from "../repositories/appEnvironment.js";
import type { IntegrationQueryClient } from "../repositories/integrationQuery.js";

export interface ResolveAppEnvInput {
  client: IntegrationQueryClient;
  secrets: SecretStore;
  orgId: string;
  projectId: string;
  environment: AppEnvironment;
  scope: AppEnvScope;
  actor: ActorRef;
}

const FrozenScopeRow = z.object({ key: z.string(), frozen_scopes: z.array(z.string()).nullable() });

/**
 * The FROZEN phase scopes for the project's `provisioned` app-env keys — read from
 * the immutable `integration_binding_env` shape (the scopes the in-15 appEnvHash
 * PROVED), keyed by env key. This is the SINGLE scope authority for provisioned
 * entries: the mutable `project_app_env.scopes` column is NEVER trusted for a
 * provisioned key, so a build/test-only binding key can never be promoted to
 * `runtime` by mutating `pae.scopes`.
 */
async function loadFrozenProvisionedScopes(input: ResolveAppEnvInput): Promise<Map<string, AppEnvScope[]>> {
  const valid = new Set<string>(APP_ENV_SCOPES);
  const result = await input.client.query(
    `SELECT pae.key AS key, be.scopes AS frozen_scopes
       FROM project_app_env pae
       JOIN integration_binding_env be
         ON be.org_id = pae.org_id AND be.project_id = pae.project_id
        AND be.binding_id = pae.binding_id AND be.binding_generation = pae.binding_generation
        AND be.key = pae.key
      WHERE pae.org_id = $1 AND pae.project_id = $2 AND pae.environment = $3 AND pae.source = 'provisioned'`,
    [input.orgId, input.projectId, input.environment],
  );
  const frozen = new Map<string, AppEnvScope[]>();
  for (const raw of result.rows) {
    const row = FrozenScopeRow.parse(raw);
    frozen.set(
      row.key,
      (row.frozen_scopes ?? []).filter((scope): scope is AppEnvScope => valid.has(scope)),
    );
  }
  return frozen;
}

/**
 * The phase scopes that AUTHORITATIVELY govern this entry: for a `provisioned`
 * entry, the FROZEN `integration_binding_env` scopes the appEnvHash proved (never
 * the mutable `pae.scopes`); for a `byo` entry, the entry's own scopes. A
 * provisioned entry with no frozen row is fail-closed (empty → excluded).
 */
function authoritativeScopes(entry: AppEnvEntry, frozen: ReadonlyMap<string, AppEnvScope[]>): readonly AppEnvScope[] {
  return entry.source === "provisioned" ? (frozen.get(entry.key) ?? []) : entry.scopes;
}

/**
 * Resolve the app-env map for one phase. Reads the project's `project_app_env`
 * entries (org-scoped via `client`), keeps only those whose AUTHORITATIVE scopes
 * include `scope`, and produces `{ KEY: value }` — plain entries inlined, secret
 * entries resolved from the SecretStore. For a PROVISIONED entry the frozen
 * `integration_binding_env` scopes govern membership (not the mutable
 * `pae.scopes`), and its secret resolves on the EXACT `{ value_ref, secret_generation }`
 * coordinate the in-15 proof digested (via `exactSecretRef`) — so the bytes SHIPPED
 * equal the bytes PROVEN. A secret ref that the manager cannot resolve fails LOUDLY.
 *
 * The returned map holds SECRET values — never log/emit it.
 */
export async function resolveAppEnvForScope(input: ResolveAppEnvInput): Promise<Record<string, string>> {
  const entries = await AppEnvironmentStore.list(
    input.client,
    input.orgId,
    input.projectId,
    input.environment,
    input.actor,
  );
  const frozen = entries.some((entry) => entry.source === "provisioned")
    ? await loadFrozenProvisionedScopes(input)
    : new Map<string, AppEnvScope[]>();

  const env: Record<string, string> = {};
  for (const entry of entries) {
    if (!authoritativeScopes(entry, frozen).includes(input.scope)) continue;
    if (entry.plainValue !== null) {
      env[entry.key] = entry.plainValue;
      continue;
    }
    // valueRef is set (the DB CHECK guarantees XOR with plainValue). Resolve the
    // secret from the manager — never the value from the DB. A PROVISIONED secret
    // resolves on the generation-authoritative coordinate the proof digested, so a
    // value_ref `/g/N` redirect can never ship bytes the proof did not cover.
    if (entry.valueRef === null) {
      throw new Error(`project_app_env entry '${entry.key}' has neither a plain value nor a secret ref`);
    }
    const ref =
      entry.source === "provisioned" && entry.secretGeneration !== null
        ? exactSecretRef(entry.valueRef, entry.secretGeneration)
        : entry.valueRef;
    const secret = await input.secrets.get(ref);
    if (secret === undefined) {
      throw new Error(`project_app_env entry '${entry.key}' references unresolved secret ref '${ref}'`);
    }
    env[entry.key] = secret.value;
  }
  return env;
}
