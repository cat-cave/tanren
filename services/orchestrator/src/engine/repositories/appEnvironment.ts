import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ActorRef } from "../state/actor.js";
import type { IntegrationQueryClient } from "./integrationQuery.js";

export const APP_ENV_SCOPES = ["build", "test", "runtime", "dev"] as const;
export type AppEnvScope = (typeof APP_ENV_SCOPES)[number];

export const APP_ENVIRONMENTS = ["dev", "test", "preview", "production"] as const;
export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];

export const APP_ENV_SOURCES = ["byo", "provisioned"] as const;
export type AppEnvSource = (typeof APP_ENV_SOURCES)[number];

export interface AppEnvEntry {
  id: string;
  orgId: string;
  projectId: string;
  environment: AppEnvironment;
  key: string;
  valueRef: string | null;
  plainValue: string | null;
  scopes: AppEnvScope[];
  source: AppEnvSource;
  bindingId: string | null;
  bindingGeneration: number | null;
  secretGeneration: number | null;
  description: string;
}

export interface UpsertAppEnvInput {
  orgId: string;
  projectId: string;
  environment: AppEnvironment;
  key: string;
  valueRef?: string;
  plainValue?: string;
  scopes: AppEnvScope[];
  source?: AppEnvSource;
  bindingId?: string;
  bindingGeneration?: number;
  secretGeneration?: number;
  description?: string;
}

const AppEnvRow = z.object({
  id: z.string(),
  org_id: z.string(),
  project_id: z.string(),
  environment: z.enum(APP_ENVIRONMENTS),
  key: z.string(),
  value_ref: z.string().nullable(),
  plain_value: z.string().nullable(),
  scopes: z.array(z.enum(APP_ENV_SCOPES)).nullable(),
  source: z.enum(APP_ENV_SOURCES),
  binding_id: z.string().nullable(),
  binding_generation: z.coerce.number().int().positive().nullable(),
  secret_generation: z.coerce.number().int().positive().nullable(),
  description: z.string(),
});
type AppEnvRow = z.infer<typeof AppEnvRow>;

function mapRow(value: unknown): AppEnvEntry {
  const row = AppEnvRow.parse(value);
  return {
    id: row.id,
    orgId: row.org_id,
    projectId: row.project_id,
    environment: row.environment,
    key: row.key,
    valueRef: row.value_ref,
    plainValue: row.plain_value,
    scopes: row.scopes ?? [],
    source: row.source,
    bindingId: row.binding_id,
    bindingGeneration: row.binding_generation,
    secretGeneration: row.secret_generation,
    description: row.description,
  };
}

const COLUMNS = `id, org_id, project_id, environment, key, value_ref,
  plain_value, scopes, source, binding_id, binding_generation,
  secret_generation, description`;

function assertInput(input: UpsertAppEnvInput): void {
  const hasRef = input.valueRef !== undefined;
  const hasPlain = input.plainValue !== undefined;
  if (hasRef === hasPlain) {
    throw new Error(
      `project_app_env entry '${input.key}' must set exactly one of valueRef (secret) / plainValue (non-secret)`,
    );
  }
  if (hasRef !== (input.secretGeneration !== undefined)) {
    throw new Error(`project_app_env secret entry '${input.key}' must carry its secretGeneration`);
  }
  if (input.secretGeneration !== undefined && input.secretGeneration < 1) {
    throw new Error(`project_app_env secretGeneration for '${input.key}' must be >= 1`);
  }
  const source = input.source ?? "byo";
  const hasBinding = input.bindingId !== undefined || input.bindingGeneration !== undefined;
  if (source === "byo" && hasBinding) {
    throw new Error(`BYO project_app_env entry '${input.key}' cannot claim an integration binding`);
  }
  if (
    source === "provisioned" &&
    (input.bindingId === undefined || input.bindingGeneration === undefined || input.bindingGeneration < 1)
  ) {
    throw new Error(`provisioned project_app_env entry '${input.key}' requires a binding and generation`);
  }
}

export const AppEnvironmentStore = {
  async upsert(client: IntegrationQueryClient, input: UpsertAppEnvInput, _actor: ActorRef): Promise<AppEnvEntry> {
    assertInput(input);
    const result = await client.query(
      `INSERT INTO project_app_env
         (org_id, id, project_id, environment, key, value_ref, plain_value,
          scopes, source, binding_id, binding_generation, secret_generation,
          description, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9, $10, $11, $12, $13, now())
       ON CONFLICT (org_id, project_id, environment, key) DO UPDATE SET
         value_ref = EXCLUDED.value_ref,
         plain_value = EXCLUDED.plain_value,
         scopes = EXCLUDED.scopes,
         source = EXCLUDED.source,
         binding_id = EXCLUDED.binding_id,
         binding_generation = EXCLUDED.binding_generation,
         secret_generation = EXCLUDED.secret_generation,
         description = EXCLUDED.description,
         updated_at = now()
       RETURNING ${COLUMNS}`,
      [
        input.orgId,
        randomUUID(),
        input.projectId,
        input.environment,
        input.key,
        input.valueRef ?? null,
        input.plainValue ?? null,
        input.scopes,
        input.source ?? "byo",
        input.bindingId ?? null,
        input.bindingGeneration ?? null,
        input.secretGeneration ?? null,
        input.description ?? "",
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(
        `project_app_env upsert returned no row for (${input.orgId}, ${input.projectId}, ${input.environment}, ${input.key})`,
      );
    }
    return mapRow(row);
  },

  async list(
    client: IntegrationQueryClient,
    orgId: string,
    projectId: string,
    environment: AppEnvironment,
    _actor: ActorRef,
  ): Promise<AppEnvEntry[]> {
    const result = await client.query(
      `SELECT ${COLUMNS} FROM project_app_env
       WHERE org_id = $1 AND project_id = $2 AND environment = $3 ORDER BY key`,
      [orgId, projectId, environment],
    );
    return result.rows.map(mapRow);
  },

  async get(
    client: IntegrationQueryClient,
    orgId: string,
    projectId: string,
    environment: AppEnvironment,
    key: string,
    _actor: ActorRef,
  ): Promise<AppEnvEntry | undefined> {
    const result = await client.query(
      `SELECT ${COLUMNS} FROM project_app_env
       WHERE org_id = $1 AND project_id = $2 AND environment = $3 AND key = $4`,
      [orgId, projectId, environment, key],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapRow(row);
  },

  async delete(
    client: IntegrationQueryClient,
    orgId: string,
    projectId: string,
    environment: AppEnvironment,
    key: string,
    _actor: ActorRef,
  ): Promise<boolean> {
    const result = await client.query(
      `DELETE FROM project_app_env
       WHERE org_id = $1 AND project_id = $2 AND environment = $3 AND key = $4
       RETURNING id`,
      [orgId, projectId, environment, key],
    );
    return (result.rowCount ?? 0) > 0;
  },
} as const;
