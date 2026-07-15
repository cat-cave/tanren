/**
 * Exact production DB-gate stage runners. Completeness is compile-time:
 * `satisfies Record<DbGateName, StageRunner>` fails typecheck if any gate is
 * missing or an unknown key is added. No casts / allowlists.
 */

import { type DbGateName } from "./stack-gates.js";
import { commandOptions } from "./stack-operations.js";
import type { SmokeState } from "./stack-receipt.js";
import { runCommand } from "./stack-runtime.js";

export type StageRunner = (state: SmokeState) => Promise<void>;

function dbGateRunner(gate: DbGateName): StageRunner {
  return async (state) => {
    await runCommand("just", [gate], commandOptions(state.context.executionRoot, state.env, state.ledger));
  };
}

/** Exact map: every `DbGateName` key present; removing one fails typecheck. */
export const DB_STAGE_RUNNERS = {
  "smoke-plane-split-p3": dbGateRunner("smoke-plane-split-p3"),
  "smoke-plane-split-p3b": dbGateRunner("smoke-plane-split-p3b"),
  "smoke-plane-split-p3c": dbGateRunner("smoke-plane-split-p3c"),
  "smoke-rls-r1": dbGateRunner("smoke-rls-r1"),
  "smoke-rls-r2": dbGateRunner("smoke-rls-r2"),
  "smoke-rls-r2-cohort2": dbGateRunner("smoke-rls-r2-cohort2"),
  "smoke-rls-r2-cohort3": dbGateRunner("smoke-rls-r2-cohort3"),
  "smoke-rls-r2-cohort4": dbGateRunner("smoke-rls-r2-cohort4"),
  "smoke-rls-r3a": dbGateRunner("smoke-rls-r3a"),
  "smoke-rls-r3a-worker": dbGateRunner("smoke-rls-r3a-worker"),
  "smoke-rls-r3b": dbGateRunner("smoke-rls-r3b"),
  "smoke-rls-early-finalize": dbGateRunner("smoke-rls-early-finalize"),
  "smoke-rls-org-bootstrap": dbGateRunner("smoke-rls-org-bootstrap"),
  "smoke-rls-operator-flow": dbGateRunner("smoke-rls-operator-flow"),
  "smoke-rls-http-route-scoping": dbGateRunner("smoke-rls-http-route-scoping"),
  "smoke-rls-run-lifecycle": dbGateRunner("smoke-rls-run-lifecycle"),
  "smoke-rls-allocator": dbGateRunner("smoke-rls-allocator"),
  "smoke-rls-environments": dbGateRunner("smoke-rls-environments"),
  "smoke-rls-design-contracts": dbGateRunner("smoke-rls-design-contracts"),
  "smoke-e2e-artifacts": dbGateRunner("smoke-e2e-artifacts"),
  "smoke-budget-gate": dbGateRunner("smoke-budget-gate"),
  "smoke-merge-authority": dbGateRunner("smoke-merge-authority"),
} satisfies Record<DbGateName, StageRunner>;
