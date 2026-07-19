/**
 * rv-12 A3 causal-correlation: the Postgres READ side over rv-8's immutable
 * `behavior_effect_observations`. It returns the recorded observations for one
 * observer+provider under the org-scoped, RLS-forced client so cross-tenant rows
 * are invisible; the pure {@link correlateEffects} core then windows + id-matches
 * them to a driven cause. Recording stays on rv-8's `observe()` poll path — this
 * reader never mutates the append-only evidence.
 */

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { CausalEffectReader, CausalEffectReaderInput } from "../acceptance/causalStage.js";
import type { EffectObservation } from "../../contracts/sideEffectObserverAdapter.js";
import { EffectObservationsRepository } from "../../repositories/effectObservations.js";

export interface PgCausalEffectReaderOptions {
  readonly repository?: EffectObservationsRepository;
}

/** Reads rv-8 effect observations for a provider under the caller's org scope. */
export class PgCausalEffectReader implements CausalEffectReader {
  private readonly repository: EffectObservationsRepository;

  public constructor(
    private readonly pool: pg.Pool,
    options: PgCausalEffectReaderOptions = {},
  ) {
    this.repository = options.repository ?? new EffectObservationsRepository();
  }

  public async effectsForProvider(input: CausalEffectReaderInput): Promise<readonly EffectObservation[]> {
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      const all = await this.repository.listForProject(client, {
        orgId: input.orgId,
        projectId: input.projectId,
      });
      return all.filter(
        (observation) => observation.observer === input.observer && observation.provider === input.provider,
      );
    });
  }
}
