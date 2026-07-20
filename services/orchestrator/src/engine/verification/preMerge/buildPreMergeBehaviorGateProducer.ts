// rv-premerge — the PRODUCTION wiring of the pre-merge behavior-gate producer. A thin
// factory: the real preview provisioner ({@link DeployAdapterPreviewSurfaceProvisioner}, the
// deploy stack) + the persisting rv-11 orchestrator (`PgAcceptanceRunStore` + real rv-6
// `HttpAcceptanceSurfaceDriver` bound to the preview URL) + the `PgAcceptancePlanLoader`.
// Wired into the planner-run input so the merge-authority stage runs it ONLY when the
// project opted into `preMergeBehaviorGate`. The worker imports ONE symbol.

import type pg from "pg";
import { fetchDeployTransport } from "../../provisioners/deployTransport.js";
import type { SecretStore } from "../../contracts/secretStore.js";
import {
  AcceptanceOrchestrator,
  HttpAcceptanceSurfaceDriver,
  PgAcceptanceEventSink,
  PgAcceptancePlanLoader,
  PgAcceptanceRunStore,
  PgDesignRenderVerdictReader,
  PgVerificationCaptureStore,
  type AcceptanceBaseUrlResolver,
  type PlanCapabilityAuthoring,
} from "../acceptance/index.js";
import { PgCasByteStore } from "../../cas/pgCasByteStore.js";
import {
  PreviewBehaviorGateProducer,
  type AcceptanceExecutorFactory,
  type PreMergeBehaviorGateProducer,
} from "./preMergeBehaviorGateProducer.js";
import { DeployAdapterPreviewSurfaceProvisioner } from "./deployAdapterPreviewProvisioner.js";
import { PgBehaviorRevisionResolver } from "../../repositories/behaviorRevisionResolver.js";

/** A base-URL resolver hard-bound to ONE preview URL for a single acceptance run. */
class FixedBaseUrlResolver implements AcceptanceBaseUrlResolver {
  public constructor(private readonly baseUrl: string) {}
  // eslint-disable-next-line @typescript-eslint/require-await
  public async resolve(): Promise<{ kind: "resolved"; baseUrl: string }> {
    return { kind: "resolved", baseUrl: this.baseUrl };
  }
}

/**
 * Build the production pre-merge behavior-gate producer. Wired into the planner-run input
 * (`RunPlannerLoopInput.preMergeBehaviorProducer`); the merge stage runs it ONLY when the
 * project's `preMergeBehaviorGate` knob is on.
 */
export function buildPreMergeBehaviorGateProducer(
  pool: pg.Pool,
  secrets: SecretStore,
  // rv-3: the OPTIONAL F2 authoring seam. When supplied (the run worker, which has the
  // Forge answerer infra), a behavior citing a MISSING verification capability is authored
  // through the writer→validate convergent loop before the gate runs; when absent, a
  // missing capability HALTS the plan load loud (fail-closed) — never a silently-empty plan.
  fragmentAuthoring?: PlanCapabilityAuthoring,
): PreMergeBehaviorGateProducer {
  // rv-9: content-address every drive's response/render capture into the SP-3 CAS +
  // verification_artifacts on the MERGE-CRITICAL pre-merge gate, so `evidenceLinkRefs` are
  // durably linked onto the persisted verdict (behavior_verdict_evidence) instead of discarded.
  const renderCapture = new PgVerificationCaptureStore(pool, new PgCasByteStore(pool));
  const buildExecutor: AcceptanceExecutorFactory = (baseUrl) =>
    new AcceptanceOrchestrator({
      // PERSIST: the `pre_merge` run + blocking verdicts land in the 0079-hardened ledger so
      // `resolveLandTimeBehaviorGate` reads them at land time.
      store: new PgAcceptanceRunStore(pool),
      events: new PgAcceptanceEventSink(pool),
      drivers: [new HttpAcceptanceSurfaceDriver({ resolveBaseUrl: new FixedBaseUrlResolver(baseUrl) })],
      renderCapture,
      // rv-13: a behavior that declares a required rendered-visual requirement is gated on the
      // ds-4 design-render verdict for the project (fail-closed) alongside its HTTP assertions.
      designRenderReader: new PgDesignRenderVerdictReader(pool),
    });
  return new PreviewBehaviorGateProducer({
    provisioner: new DeployAdapterPreviewSurfaceProvisioner(pool, { transport: fetchDeployTransport(), secrets }),
    behaviorRevisions: new PgBehaviorRevisionResolver(pool),
    planLoader: new PgAcceptancePlanLoader(
      pool,
      fragmentAuthoring === undefined ? {} : { authoring: fragmentAuthoring },
    ),
    buildExecutor,
  });
}
