import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { QueryClient } from "../data/orgScopedDb.js";
import { PgEventStore } from "../eventStore.js";
import { compilePolicy, type CompiledPolicy } from "./policyCompiler.js";
import { PolicyAstSchema, type PolicyAst } from "./policyAst.js";
import { GovernanceTierPresetSchema, governanceTierPreset, type GovernanceTierPreset } from "./tierPresets.js";

const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

const TierRowSchema = z
  .object({
    id: z.string().min(1),
    project_id: z.string().min(1),
    tier_name: z.string().min(1),
    preset: GovernanceTierPresetSchema,
    tier_json: z.unknown(),
    canonical_hash: DigestSchema,
    state: z.string().min(1),
    created_at: z.string(),
  })
  .strict();

const BindingRowSchema = z
  .object({
    id: z.string().min(1),
    project_id: z.string().min(1),
    tier_id: z.string().min(1),
    effective_policy_hash: DigestSchema,
    created_at: z.string(),
  })
  .strict();

export interface GovernanceTier {
  readonly id: string;
  readonly projectId: string;
  readonly tierName: string;
  readonly preset: GovernanceTierPreset;
  readonly tierJson: PolicyAst;
  readonly canonicalHash: string;
  readonly state: string;
  readonly createdAt: string;
}

export interface PolicyBinding {
  readonly id: string;
  readonly projectId: string;
  readonly tierId: string;
  readonly effectivePolicyHash: string;
  readonly createdAt: string;
}

export interface CreateGovernanceTierInput {
  readonly orgId: string;
  readonly projectId: string;
  readonly tierName: string;
  readonly preset: GovernanceTierPreset;
}

export interface BindGovernanceTierInput {
  readonly orgId: string;
  readonly projectId: string;
  readonly tierId: string;
}

export class GovernanceTierNotFoundError extends Error {
  constructor(tierId: string) {
    super(`governance tier not found: ${tierId}`);
    this.name = "GovernanceTierNotFoundError";
  }
}

export class GovernanceTierIntegrityError extends Error {
  constructor(tierId: string) {
    super(`governance tier is not reproducibly compiled: ${tierId}`);
    this.name = "GovernanceTierIntegrityError";
  }
}

function decodeTier(input: unknown): GovernanceTier {
  const row = TierRowSchema.parse(input);
  return {
    id: row.id,
    projectId: row.project_id,
    tierName: row.tier_name,
    preset: row.preset,
    tierJson: PolicyAstSchema.parse(row.tier_json),
    canonicalHash: row.canonical_hash,
    state: row.state,
    createdAt: row.created_at,
  };
}

function decodeBinding(input: unknown): PolicyBinding {
  const row = BindingRowSchema.parse(input);
  return {
    id: row.id,
    projectId: row.project_id,
    tierId: row.tier_id,
    effectivePolicyHash: row.effective_policy_hash,
    createdAt: row.created_at,
  };
}

function compileTierDocument(document: unknown, tierId: string): CompiledPolicy {
  const compiled = compilePolicy(document);
  if (compiled.status === "contradictory") throw new GovernanceTierIntegrityError(tierId);
  return compiled;
}

function compileStoredTier(tier: GovernanceTier): CompiledPolicy {
  const compiled = compileTierDocument(tier.tierJson, tier.id);
  if (compiled.policyHash !== tier.canonicalHash) throw new GovernanceTierIntegrityError(tier.id);
  return compiled;
}

function repositoryVisibility(compiled: CompiledPolicy, tierId: string): "public" | "private" {
  const value = compiled.ast.rules.find((rule) => rule.key === "repository.visibility")?.value;
  if (value !== "public" && value !== "private") throw new GovernanceTierIntegrityError(tierId);
  return value;
}

async function getTier(client: QueryClient, orgId: string, projectId: string, tierId: string): Promise<GovernanceTier> {
  const result = await client.query(
    `SELECT id, project_id, tier_name, preset, tier_json, canonical_hash, state, created_at::text
       FROM governance_tiers
      WHERE org_id = $1 AND project_id = $2 AND id = $3`,
    [orgId, projectId, tierId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new GovernanceTierNotFoundError(tierId);
  return decodeTier(row);
}

export async function createGovernanceTier(
  client: QueryClient,
  input: CreateGovernanceTierInput,
): Promise<GovernanceTier> {
  const preset = governanceTierPreset(input.preset);
  const compiled = compileTierDocument(preset.sourceDocument, input.tierName);
  const id = `governance_tier_${randomUUID()}`;
  const inserted = await client.query(
    `INSERT INTO governance_tiers
       (org_id, project_id, id, tier_name, preset, tier_json, canonical_hash, state)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 'active')
     RETURNING id, project_id, tier_name, preset, tier_json, canonical_hash, state, created_at::text`,
    [
      input.orgId,
      input.projectId,
      id,
      input.tierName,
      input.preset,
      JSON.stringify(preset.sourceDocument),
      compiled.policyHash,
    ],
  );
  const row = inserted.rows[0];
  if (row === undefined) throw new Error("governance tier insert returned no row");
  const tier = decodeTier(row);
  await new PgEventStore(client).append({
    orgId: input.orgId,
    projectId: input.projectId,
    eventType: "governance.tier.created",
    payload: {
      projectId: tier.projectId,
      tierId: tier.id,
      tierName: tier.tierName,
      preset: tier.preset,
      canonicalHash: tier.canonicalHash,
    },
  });
  return tier;
}

export async function listGovernanceTiers(
  client: QueryClient,
  orgId: string,
  projectId: string,
): Promise<GovernanceTier[]> {
  const result = await client.query(
    `SELECT id, project_id, tier_name, preset, tier_json, canonical_hash, state, created_at::text
       FROM governance_tiers
      WHERE org_id = $1 AND project_id = $2
      ORDER BY created_at, id`,
    [orgId, projectId],
  );
  return result.rows.map(decodeTier);
}

async function existingBinding(
  client: QueryClient,
  orgId: string,
  projectId: string,
  tierId: string,
): Promise<PolicyBinding | undefined> {
  const result = await client.query(
    `SELECT id, project_id, tier_id, effective_policy_hash, created_at::text
       FROM policy_bindings
      WHERE org_id = $1 AND project_id = $2 AND tier_id = $3`,
    [orgId, projectId, tierId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : decodeBinding(row);
}

async function enforceRepositoryVisibility(
  client: QueryClient,
  orgId: string,
  projectId: string,
  visibility: "public" | "private",
): Promise<void> {
  const result = await client.query(
    `UPDATE projects
        SET repo_visibility = $3
      WHERE org_id = $1 AND project_id = $2`,
    [orgId, projectId, visibility],
  );
  if (result.rowCount !== 1) throw new Error("governance tier project does not exist");
}

/**
 * A binding is the immutable activation receipt for a tier on its project.
 * Repeating the request keeps the visibility projection enforced but never
 * creates a second binding or activation event.
 */
export async function bindGovernanceTier(
  client: QueryClient,
  input: BindGovernanceTierInput,
): Promise<{ readonly tier: GovernanceTier; readonly binding: PolicyBinding }> {
  const tier = await getTier(client, input.orgId, input.projectId, input.tierId);
  const compiled = compileStoredTier(tier);
  const visibility = repositoryVisibility(compiled, tier.id);
  const existing = await existingBinding(client, input.orgId, input.projectId, tier.id);
  if (existing !== undefined) {
    if (existing.effectivePolicyHash !== compiled.policyHash) throw new GovernanceTierIntegrityError(tier.id);
    await enforceRepositoryVisibility(client, input.orgId, input.projectId, visibility);
    return { tier, binding: existing };
  }

  const id = `policy_binding_${randomUUID()}`;
  const inserted = await client.query(
    `INSERT INTO policy_bindings (org_id, project_id, id, tier_id, effective_policy_hash)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (org_id, project_id, tier_id) DO NOTHING
     RETURNING id, project_id, tier_id, effective_policy_hash, created_at::text`,
    [input.orgId, input.projectId, id, tier.id, compiled.policyHash],
  );
  const row = inserted.rows[0];
  if (row === undefined) {
    const concurrent = await existingBinding(client, input.orgId, input.projectId, tier.id);
    if (concurrent === undefined || concurrent.effectivePolicyHash !== compiled.policyHash) {
      throw new GovernanceTierIntegrityError(tier.id);
    }
    await enforceRepositoryVisibility(client, input.orgId, input.projectId, visibility);
    return { tier, binding: concurrent };
  }
  const binding = decodeBinding(row);
  await enforceRepositoryVisibility(client, input.orgId, input.projectId, visibility);
  await new PgEventStore(client).append({
    orgId: input.orgId,
    projectId: input.projectId,
    eventType: "governance.tier.activated",
    payload: {
      projectId: tier.projectId,
      tierId: tier.id,
      tierName: tier.tierName,
      policyBindingId: binding.id,
      effectivePolicyHash: binding.effectivePolicyHash,
    },
  });
  return { tier, binding };
}
