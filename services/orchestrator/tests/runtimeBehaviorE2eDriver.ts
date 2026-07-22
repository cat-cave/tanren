// The runtime-behavior e2e driver (audit §6.8).
//
// This is the HERMETIC, IN-PROCESS mirror of the live tier driver
// (tests/e2e/cases/tierProofs.e2e.ts `tierDriver`): where the live driver POSTs
// to a real stack and asserts on real GitHub/Postgres artifacts, this driver POSTs
// rough operator notes → derives the DAG → walks it to merged PRs → deploys →
// re-enters the loop, against the e2e harness's existing FAKES (an in-memory
// CodeHost, the scripted deploy transport + URL probe, fake answerers) and the
// engine's REAL pure decision functions (the cost-basis classifier, the audit-
// posture severity gate, the budget-pause predicate, the issue-webhook mapper).
// NO network, NO real credentials, NO real Postgres — so the runtime behavior proof surface is
// REGRESSION-PINNED in `just fast-check`, reproducible in CI, not just anecdotal
// in a credentialed live run.
//
// It is the SOLE integrated proof that the runtime behavior autonomy-loop STAGES COMPOSE: each
// stage's deep wiring is pinned by its own focused test (deriveProject, the
// DagWalker, the MergeAuthority truth table, deployOnMerge, the intake pipeline,
// the scheduled-audit re-enter); THIS driver proves they chain into one coherent
// runtime behavior run end-to-end. The driver returns a typed PROOF object; the test asserts
// every autonomy-loop stage left its real artifact.
//
// This file is the PUBLIC TYPES surface: the runtime behavior SEED + operator notes, the typed
// PROOF surface (one field per autonomy-loop stage), and the driver-input knobs.
// The stage wiring + `driveRuntimeBehavior` itself live in runtimeBehaviorE2eDriver.drive.ts (split to
// keep each file ≤500 lines + avoid an import cycle): the drive module imports
// these types; the test imports the constants/types from here and `driveRuntimeBehavior` from
// the drive module.

import type { AuditPosture } from "../src/engine/contracts/auditPosture.js";

// ---------------------------------------------------------------------------
// The runtime-behavior seed: a fake template + the rough operator notes the operator submits.
// v32 runs templated (audit §3.11 — the template path is THE run path), so the
// driver derives FROM a (fake) template seed, never from-scratch.
// ---------------------------------------------------------------------------

/** A fake validated template seed — the contract-instance v32 derives onto. */
export interface RuntimeBehaviorTemplateSeed {
  readonly templateRef: string;
  /** The contract files the seed materializes on the greenfield base (proof the seed landed). */
  readonly seededFiles: readonly string[];
}

export const RUNTIME_BEHAVIOR_TEMPLATE_SEED: RuntimeBehaviorTemplateSeed = {
  templateRef: "template/node-web-service@lts",
  seededFiles: ["justfile", ".tanren/ci.yml", "package.json"],
};

/** The rough operator notes the operator POSTs (the runtime behavior input: a few prose lines). */
export const RUNTIME_BEHAVIOR_OPERATOR_NOTES =
  "Build a URL shortener: an API to shorten + resolve links, a tiny web UI, and a Slack bot. " +
  "Should be functional but doesn't need to be fancy.";

// One spec the derive stage authors from the notes. `dependsOn` carries the DAG
// edges the walker orders by; `target` is the deterministic marker file the merge
// proves landed on the base branch.
export interface RuntimeBehaviorDerivedSpec {
  readonly specId: string;
  readonly title: string;
  readonly dependsOn: readonly string[];
  readonly target: string;
  /** The role rows this spec spends on (each becomes a cost_records row). */
  readonly roles: readonly RuntimeBehaviorRoleSpend[];
}

// A single billable role call in the spec's run (writer/checker/auditor). The
// authRef drives the REAL cost-basis classifier — proving cost rows carry the
// right cost_basis + billing_mode for the credential the operator imported.
export interface RuntimeBehaviorRoleSpend {
  readonly role: "write" | "check" | "audit";
  readonly authRef: string;
  readonly providerCostUsd: number | null;
}

// ---------------------------------------------------------------------------
// The PROOF surface — one field per autonomy-loop stage. The test asserts each.
// ---------------------------------------------------------------------------

export interface MergedPrProof {
  readonly specId: string;
  readonly prUrl: string;
  readonly mergeCommitSha: string;
  readonly targetFileOnBase: string;
}

export interface CostRowProof {
  readonly specId: string;
  readonly role: RuntimeBehaviorRoleSpend["role"];
  readonly costBasis: string;
  readonly billingMode: string;
  readonly realSpendUsd: number | null;
}

export interface DeployProof {
  /** The git ref the deploy transport was actually triggered against. */
  readonly deployedRef: string;
  /** The merge commit the deploy MUST target (live-reflects-merge). */
  readonly expectedMergeSha: string;
  /** The resolved deploy URL the probe smoke-checked. */
  readonly probedUrl: string;
  /** The faked deploy-URL status (200 = reachable). */
  readonly probeStatus: number;
}

export interface SeverityGateProof {
  /** Under the velocity posture: a P2 finding ROUTES to the DAG (does not block). */
  readonly velocityRoutedSpecIds: readonly string[];
  /** Under the strict posture: the SAME P2 finding BLOCKS the merge. */
  readonly strictBlocks: boolean;
}

export interface BudgetProof {
  /** Whether the run PAUSED at the ceiling (`dag.budget.paused` fires). */
  readonly paused: boolean;
  readonly ceilingUsd: number;
  readonly spentUsd: number;
}

export interface IssueLoopProof {
  /** The externalId the issue webhook mapped to (proof the issue ingested). */
  readonly ingestedExternalId: string;
  /** The spec the triage routed into the DAG (proof issue → triage → spec). */
  readonly routedSpecId: string;
  /** The merged PR the routed spec reached (proof issue → … → merge). */
  readonly mergedPrUrl: string;
}

export interface FeatureRequestProof {
  /** A feature-request note → a derived spec id in the DAG. */
  readonly derivedSpecId: string;
}

export interface ScheduledAuditProof {
  /** A scheduled audit's residual finding routed back into the DAG as a spec. */
  readonly reEnteredSpecId: string;
}

export interface RuntimeBehaviorProof {
  readonly templateRef: string;
  readonly seededFiles: readonly string[];
  readonly derivedSpecIds: readonly string[];
  readonly mergedPrs: readonly MergedPrProof[];
  readonly costRows: readonly CostRowProof[];
  readonly deploy: DeployProof;
  readonly severityGate: SeverityGateProof;
  readonly budget: BudgetProof;
  readonly issueLoop: IssueLoopProof;
  readonly featureRequest: FeatureRequestProof;
  readonly scheduledAudit: ScheduledAuditProof;
  /** The DORA deployment count accumulated across every merged run (proof DORA accrued). */
  readonly doraDeploymentCount: number;
}

// ---------------------------------------------------------------------------
// The driver knobs — everything the test can vary (the budget ceiling, the
// per-spec spend, the injected issue/feature/audit). Defaults model a healthy run.
// ---------------------------------------------------------------------------

export interface RuntimeBehaviorDriverInput {
  readonly seed?: RuntimeBehaviorTemplateSeed;
  readonly notes?: string;
  /** The dollar ceiling the operator configured (the budget gate). */
  readonly budgetCeilingUsd?: number;
  /** The DORA audit-posture knob (velocity by default — P2/P3 route, don't block). */
  readonly auditPosture?: AuditPosture;
  /** Force the run OVER the ceiling (to prove the pause fires). Default: under. */
  readonly overspend?: boolean;
}
