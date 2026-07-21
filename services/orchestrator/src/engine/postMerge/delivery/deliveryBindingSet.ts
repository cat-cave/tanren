/**
 * Seals the exact release-required product binding generations before the live
 * delivery executes. The A3 effect reader later consumes this immutable set,
 * never `integration_bindings.current_generation`, so proof and effect cannot
 * diverge during a binding rotation.
 */

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { z } from "zod";
import type { DeliveryLineage } from "./stageModel.js";

export interface DeliveryBindingSetSealer {
  seal(input: {
    readonly lineage: DeliveryLineage;
    readonly deliveryRunId: string;
    readonly token: string;
  }): Promise<BindingSetSealResult>;
}

export type BindingSetSealResult =
  | { readonly kind: "sealed"; readonly count: number }
  | { readonly kind: "unavailable"; readonly detail: string };

const ExpectedRow = z
  .object({
    requirement_id: z.string().min(1),
    binding_id: z.string().min(1).nullable(),
    binding_generation: z.coerce.number().int().positive().nullable(),
  })
  .strict();

const SealedRow = z
  .object({ binding_id: z.string().min(1), binding_generation: z.coerce.number().int().positive() })
  .strict();

/** PostgreSQL implementation; all reads/writes carry org scope and the live claim token. */
export class PgDeliveryBindingSetSealer implements DeliveryBindingSetSealer {
  public constructor(private readonly pool: pg.Pool) {}

  public async seal(input: {
    readonly lineage: DeliveryLineage;
    readonly deliveryRunId: string;
    readonly token: string;
  }): Promise<BindingSetSealResult> {
    if (input.token.trim() === "") return unavailable("release binding set has no live delivery claim fence");
    return runWithOrgScope(this.pool, input.lineage.orgId, async (client) => {
      const expectedResult = await client.query(
        `SELECT r.id AS requirement_id, b.id AS binding_id, b.current_generation AS binding_generation
           FROM integration_requirements r
           LEFT JOIN integration_bindings b
             ON b.org_id = r.org_id AND b.project_id = r.project_id AND b.requirement_id = r.id
            AND b.environment = 'production' AND b.status = 'ready' AND b.current_generation IS NOT NULL
          WHERE r.org_id = $1 AND r.project_id = $2 AND r.plane = 'product'
            AND r.status = 'active' AND r.criticality = 'release_required'
          ORDER BY r.id, b.id`,
        [input.lineage.orgId, input.lineage.projectId],
      );
      const rows: z.infer<typeof ExpectedRow>[] = [];
      for (const raw of expectedResult.rows) {
        const parsed = ExpectedRow.safeParse(raw);
        if (!parsed.success) return unavailable("release binding query returned malformed data");
        rows.push(parsed.data);
      }
      if (rows.some((row) => row.binding_id === null || row.binding_generation === null)) {
        return unavailable("a release-required product requirement has no ready production binding generation");
      }
      const requirements = new Set(rows.map((row) => row.requirement_id));
      if (requirements.size !== rows.length)
        return unavailable("a release-required requirement resolves to multiple binding generations");

      const desired: { bindingId: string; bindingGeneration: number }[] = [];
      for (const row of rows) {
        if (row.binding_id === null || row.binding_generation === null) {
          return unavailable("a release-required product requirement has no ready production binding generation");
        }
        desired.push({ bindingId: row.binding_id, bindingGeneration: row.binding_generation });
      }
      const existing = await this.existing(client, input);
      if (existing.length > 0)
        return equalSets(existing, desired)
          ? { kind: "sealed", count: desired.length }
          : unavailable("sealed delivery binding set differs from release-required bindings");
      if (desired.length === 0) return { kind: "sealed", count: 0 };

      const inserted = await client.query(
        `INSERT INTO delivery_run_bindings (org_id, project_id, delivery_run_id, binding_id, binding_generation)
         SELECT $1, $2, $3, entry.binding_id, entry.binding_generation
           FROM unnest($4::text[], $5::int[]) AS entry(binding_id, binding_generation)
          WHERE EXISTS (
            SELECT 1 FROM delivery_runs
             WHERE org_id = $1 AND id = $3 AND claim_owner = $6 AND status = 'running'
          )`,
        [
          input.lineage.orgId,
          input.lineage.projectId,
          input.deliveryRunId,
          desired.map((row) => row.bindingId),
          desired.map((row) => row.bindingGeneration),
          input.token,
        ],
      );
      if (inserted.rowCount !== desired.length)
        return unavailable("delivery claim was lost while sealing release binding set");
      const sealed = await this.existing(client, input);
      return equalSets(sealed, desired)
        ? { kind: "sealed", count: desired.length }
        : unavailable("sealed delivery binding set is incomplete or contains extras");
    });
  }

  private async existing(
    client: Pick<pg.PoolClient, "query">,
    input: { readonly lineage: DeliveryLineage; readonly deliveryRunId: string },
  ): Promise<readonly { bindingId: string; bindingGeneration: number }[]> {
    const result = await client.query(
      `SELECT binding_id, binding_generation FROM delivery_run_bindings
        WHERE org_id = $1 AND project_id = $2 AND delivery_run_id = $3
        ORDER BY binding_id, binding_generation`,
      [input.lineage.orgId, input.lineage.projectId, input.deliveryRunId],
    );
    const sealed: { bindingId: string; bindingGeneration: number }[] = [];
    for (const raw of result.rows) {
      const parsed = SealedRow.safeParse(raw);
      if (!parsed.success) throw new Error("sealed delivery binding set contains malformed data");
      sealed.push({ bindingId: parsed.data.binding_id, bindingGeneration: parsed.data.binding_generation });
    }
    return sealed;
  }
}

function equalSets(
  left: readonly { bindingId: string; bindingGeneration: number }[],
  right: readonly { bindingId: string; bindingGeneration: number }[],
): boolean {
  if (left.length !== right.length) return false;
  const values = new Set(left.map((row) => `${row.bindingId}\u0000${String(row.bindingGeneration)}`));
  return (
    values.size === left.length &&
    right.every((row) => values.has(`${row.bindingId}\u0000${String(row.bindingGeneration)}`))
  );
}

function unavailable(detail: string): BindingSetSealResult {
  return { kind: "unavailable", detail };
}
