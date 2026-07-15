/**
 * failure-recovery client surface, split out of `orchestrator.ts` so
 * the product client stays under the 500-line architecture cap (same split
 * rationale as `httpClient.ts`). These methods land on `OrchestratorClient`
 * via inheritance — `OrchestratorClient extends OrchestratorRecoveryClient` —
 * so callers use `client.recoveryRevise(...)` exactly as if they were declared
 * inline. Reads/writes the orchestrator recovery routes; writes go through the
 * shared `sendJson` helper that forwards the session cookie, keeping the
 * orchestrator URL server-side.
 */

import { OrchestratorHttpClient } from "./httpClient.js";
import type { RecoveryActionResult, RecoveryContext } from "./recoveryTypes.js";
import type { RunLocation } from "./types.js";
import { decodeWith, RecoveryActionResultSchema } from "./writeResponseSchemas.js";

export abstract class OrchestratorRecoveryClient extends OrchestratorHttpClient {
  private recoveryBase(loc: RunLocation, runId: string): string {
    return `/orgs/${encodeURIComponent(loc.orgId)}/projects/${encodeURIComponent(
      loc.projectId,
    )}/runs/${encodeURIComponent(runId)}/recovery`;
  }

  /** Recovery context for a halted run (which cards are enabled). */
  async getRecoveryContext(loc: RunLocation, runId: string): Promise<RecoveryContext | undefined> {
    return this.getJson<RecoveryContext>(this.recoveryBase(loc, runId));
  }

  /** revise_spec — record the intent + get the spec-edit href. */
  async recoveryRevise(loc: RunLocation, runId: string): Promise<RecoveryActionResult> {
    const r = await this.sendJson<RecoveryActionResult>("POST", `${this.recoveryBase(loc, runId)}/revise`, undefined, {
      expectBody: true,
      decode: (value) => decodeWith(RecoveryActionResultSchema, value),
    });
    return r.body ?? { ok: r.ok };
  }

  /** replan_with_steering — re-invoke the planner with the operator's note. */
  async recoveryReplan(loc: RunLocation, runId: string, steeringNote: string): Promise<RecoveryActionResult> {
    const r = await this.sendJson<RecoveryActionResult>(
      "POST",
      `${this.recoveryBase(loc, runId)}/replan`,
      {
        steeringNote,
      },
      { expectBody: true, decode: (value) => decodeWith(RecoveryActionResultSchema, value) },
    );
    return r.body ?? { ok: r.ok };
  }

  /** rollback_to_commit — reset the workspace to a commit + re-queue (confirmed). */
  async recoveryRollback(
    loc: RunLocation,
    runId: string,
    input: { commitSha: string; confirmed: boolean },
  ): Promise<RecoveryActionResult> {
    const r = await this.sendJson<RecoveryActionResult>("POST", `${this.recoveryBase(loc, runId)}/rollback`, input, {
      expectBody: true,
      decode: (value) => decodeWith(RecoveryActionResultSchema, value),
    });
    return r.body ?? { ok: r.ok };
  }

  /** open_inspection_thread — create a run-scoped Forge thread (read-only). */
  async recoveryInspectionThread(loc: RunLocation, runId: string): Promise<RecoveryActionResult> {
    const r = await this.sendJson<RecoveryActionResult>(
      "POST",
      `${this.recoveryBase(loc, runId)}/inspection-thread`,
      undefined,
      { expectBody: true, decode: (value) => decodeWith(RecoveryActionResultSchema, value) },
    );
    return r.body ?? { ok: r.ok };
  }
}
