import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { QueryClient } from "../data/orgScopedDb.js";
import { PgEventStore } from "../eventStore.js";
import { recordEffectivePolicySnapshot } from "./effectivePolicySnapshotStore.js";
import { compilePolicy, type CompiledPolicy } from "./policyCompiler.js";
import { PolicyAstSchema, type PolicyAst } from "./policyAst.js";
import { createPolicyRevision, findPolicyRevisionByHash, type PolicyRevision } from "./policyRevisionStore.js";
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
    is_active: z.boolean(),
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
  readonly isActive: boolean;
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
  readonly createdBy?: string;
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
    isActive: row.is_active,
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

export class GovernanceTierAmbiguousNameError extends Error {
  constructor(tierName: string) {
    super(`governance tier name is ambiguous: ${tierName}`);
    this.name = "GovernanceTierAmbiguousNameError";
  }
}

/**
 * Resolve a tier by its human name within a project. Fail-closed on ambiguity:
 * tier names are not unique in the schema, so an import that names a tier which
 * resolves to more than one row must be rejected whole rather than pick one.
 */
export async function getGovernanceTierByName(
  client: QueryClient,
  orgId: string,
  projectId: string,
  tierName: string,
): Promise<GovernanceTier> {
  const result = await client.query(
    `SELECT id, project_id, tier_name, preset, tier_json, canonical_hash, state, created_at::text
       FROM governance_tiers
      WHERE org_id = $1 AND project_id = $2 AND tier_name = $3`,
    [orgId, projectId, tierName],
  );
  if (result.rows.length === 0) throw new GovernanceTierNotFoundError(tierName);
  if (result.rows.length > 1) throw new GovernanceTierAmbiguousNameError(tierName);
  return decodeTier(result.rows[0]);
}

export async function listPolicyBindings(
  client: QueryClient,
  orgId: string,
  projectId: string,
): Promise<PolicyBinding[]> {
  const result = await client.query(
    `SELECT id, project_id, tier_id, effective_policy_hash, is_active, created_at::text
       FROM policy_bindings
      WHERE org_id = $1 AND project_id = $2
      ORDER BY created_at, id`,
    [orgId, projectId],
  );
  return result.rows.map(decodeBinding);
}

async function existingBinding(
  client: QueryClient,
  orgId: string,
  projectId: string,
  tierId: string,
): Promise<PolicyBinding | undefined> {
  const result = await client.query(
    `SELECT id, project_id, tier_id, effective_policy_hash, is_active, created_at::text
       FROM policy_bindings
      WHERE org_id = $1 AND project_id = $2 AND tier_id = $3`,
    [orgId, projectId, tierId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : decodeBinding(row);
}

async function activeBinding(
  client: QueryClient,
  orgId: string,
  projectId: string,
): Promise<PolicyBinding | undefined> {
  const result = await client.query(
    `SELECT id, project_id, tier_id, effective_policy_hash, is_active, created_at::text
       FROM policy_bindings
      WHERE org_id = $1 AND project_id = $2 AND is_active
      LIMIT 1`,
    [orgId, projectId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : decodeBinding(row);
}

async function bindingRevision(
  client: QueryClient,
  input: BindGovernanceTierInput,
  tier: GovernanceTier,
): Promise<PolicyRevision> {
  const existing = await findPolicyRevisionByHash(client, input.orgId, input.projectId, tier.canonicalHash);
  if (existing !== undefined) return existing;
  return createPolicyRevision(client, {
    orgId: input.orgId,
    projectId: input.projectId,
    sourceDocument: tier.tierJson,
    createdBy: input.createdBy ?? "system:governance-binding",
  });
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
 * A binding retains the immutable policy identity for a tier; its explicit
 * active flag selects the one policy currently governing a project. Repeating
 * an activation for the already-active tier is idempotent, but re-promoting a
 * superseded tier is a new activation and must supersede the current binding.
 */
export async function bindGovernanceTier(
  client: QueryClient,
  input: BindGovernanceTierInput,
): Promise<{ readonly tier: GovernanceTier; readonly binding: PolicyBinding; readonly policyRevisionId: string }> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`governance-binding:${input.projectId}`]);
  const tier = await getTier(client, input.orgId, input.projectId, input.tierId);
  const compiled = compileStoredTier(tier);
  const revision = await bindingRevision(client, input, tier);
  if (revision.policyHash !== compiled.policyHash) throw new GovernanceTierIntegrityError(tier.id);
  const visibility = repositoryVisibility(compiled, tier.id);
  const existing = await existingBinding(client, input.orgId, input.projectId, tier.id);
  if (existing !== undefined && existing.effectivePolicyHash !== compiled.policyHash) {
    throw new GovernanceTierIntegrityError(tier.id);
  }
  const prior = await activeBinding(client, input.orgId, input.projectId);
  if (prior !== undefined && existing?.id === prior.id) {
    await enforceRepositoryVisibility(client, input.orgId, input.projectId, visibility);
    return { tier, binding: existing, policyRevisionId: revision.id };
  }

  if (prior !== undefined) {
    const superseded = await client.query(
      `UPDATE policy_bindings
          SET is_active = false
        WHERE org_id = $1 AND project_id = $2 AND id = $3 AND is_active
        RETURNING id`,
      [input.orgId, input.projectId, prior.id],
    );
    if (superseded.rowCount !== 1) {
      throw new GovernanceTierIntegrityError(tier.id);
    }
  }

  if (existing !== undefined) {
    const reactivated = await client.query(
      `UPDATE policy_bindings
          SET is_active = true
        WHERE org_id = $1 AND project_id = $2 AND id = $3 AND NOT is_active
        RETURNING id, project_id, tier_id, effective_policy_hash, is_active, created_at::text`,
      [input.orgId, input.projectId, existing.id],
    );
    const row = reactivated.rows[0];
    if (row === undefined) throw new GovernanceTierIntegrityError(tier.id);
    return activateBinding(client, input, tier, decodeBinding(row), revision.id, prior, visibility);
  }
  const inserted = await client.query(
    `INSERT INTO policy_bindings (org_id, project_id, id, tier_id, effective_policy_hash, is_active)
     VALUES ($1, $2, $3, $4, $5, true)
     RETURNING id, project_id, tier_id, effective_policy_hash, is_active, created_at::text`,
    [input.orgId, input.projectId, `policy_binding_${randomUUID()}`, tier.id, compiled.policyHash],
  );
  const row = inserted.rows[0];
  if (row === undefined) throw new GovernanceTierIntegrityError(tier.id);
  const binding = decodeBinding(row);
  if (!binding.isActive) throw new GovernanceTierIntegrityError(tier.id);
  return activateBinding(client, input, tier, binding, revision.id, prior, visibility);
}

async function activateBinding(
  client: QueryClient,
  input: BindGovernanceTierInput,
  tier: GovernanceTier,
  binding: PolicyBinding,
  policyRevisionId: string,
  prior: PolicyBinding | undefined,
  visibility: "public" | "private",
): Promise<{ readonly tier: GovernanceTier; readonly binding: PolicyBinding; readonly policyRevisionId: string }> {
  await enforceRepositoryVisibility(client, input.orgId, input.projectId, visibility);
  await new PgEventStore(client).append({
    orgId: input.orgId,
    projectId: input.projectId,
    eventType: "governance.binding.activated",
    payload: {
      projectId: tier.projectId,
      bindingId: binding.id,
      tierId: tier.id,
      policyRevisionId,
      effectivePolicyHash: binding.effectivePolicyHash,
    },
  });
  await recordEffectivePolicySnapshot(client, {
    orgId: input.orgId,
    projectId: input.projectId,
    bindingId: binding.id,
    subjectKind: "activation",
    subjectId: binding.id,
    createdBy: input.createdBy ?? "system:governance-binding",
  });
  if (prior !== undefined) {
    await new PgEventStore(client).append({
      orgId: input.orgId,
      projectId: input.projectId,
      eventType: "governance.binding.superseded",
      payload: {
        projectId: input.projectId,
        bindingId: prior.id,
        supersededByBindingId: binding.id,
        tierId: prior.tierId,
      },
    });
  }
  return { tier, binding, policyRevisionId };
}
