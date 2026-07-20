// rv-16b — the REAL candidate re-prover behind the regression bisector's probe seam. Each
// probe runs the SAME rv-11 {@link AcceptanceOrchestrator} + rv-6 {@link HttpAcceptanceSurfaceDriver}
// the pre-merge gate and rv-16a post-merge lane use — firing REAL HTTP against the candidate
// release's environment and resolving the outcome through the orchestrator's fail-closed
// `resolveOutcome`. The verdict is NEVER fabricated: a 200-but-broken candidate re-proves
// `failed_product`, an unreachable candidate re-proves `inconclusive_infrastructure`.
//
// The probe RUN is executed through an EPHEMERAL store/sink (the same non-persisting seam the
// proof-backed demo uses): the diagnostic re-probe MUST NOT pollute the immutable production
// `behavior_verdicts` ledger with non-production verdicts. The REAL work (drive + assertion
// algebra + outcome resolution) still happens; only the durable record is the 0083 bisection
// row + probe trail. So a non-persisting sink cannot launder a verdict.
//
// WHERE the environment comes from is the {@link CandidateEnvironmentResolver} seam. The shipped
// impl probes the candidate's RECORDED deployment URL directly — the honest substrate available
// today (there is NO on-demand redeploy-by-digest primitive; see the rv-16b report). A superseded/
// reaped candidate whose deployment is gone fails closed to `inconclusive_infrastructure` when the
// real driver cannot reach it — never a fabricated verdict. A future redeploy-by-source-ref
// resolver (via `DeployAdapter.applyPreview`) is a drop-in for the SAME seam with zero bisector change.

import type { AcceptanceBaseUrlResolver, HttpFetch } from "../acceptance/httpDriver.js";
import {
  AcceptanceOrchestrator,
  HttpAcceptanceSurfaceDriver,
  type AcceptancePlan,
  type AcceptancePlanLoader,
} from "../acceptance/index.js";
import { EphemeralAcceptanceEventSink, EphemeralAcceptanceRunStore } from "../../demo/proofBackedWebDemo.js";
import { parseDigest } from "../../contracts/cas.js";
import type { BehaviorVerdictOutcome } from "../../contracts/runtimeVerificationAdapters.js";
import type { CandidateBehaviorReprover, CandidateRelease } from "./regressionBisection.js";

/** Resolves the environment a candidate release is re-proven against, or why it is unavailable. */
export type CandidateEnvironmentResolution =
  | { readonly kind: "available"; readonly baseUrl: string }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface CandidateEnvironmentResolver {
  resolve(candidate: CandidateRelease): Promise<CandidateEnvironmentResolution>;
}

/**
 * The shipped resolver: the candidate's OWN recorded deployment URL. Honest + real — it probes
 * the exact URL that release was deployed at. A candidate with no recorded URL is `unavailable`
 * (fail-closed → inconclusive probe); a recorded-but-dead URL fails closed inside the real driver
 * (network error → inconclusive_infrastructure) rather than being laundered into a verdict.
 */
export class RecordedUrlCandidateEnvironmentResolver implements CandidateEnvironmentResolver {
  // eslint-disable-next-line @typescript-eslint/require-await
  public async resolve(candidate: CandidateRelease): Promise<CandidateEnvironmentResolution> {
    if (candidate.url === "") {
      return { kind: "unavailable", reason: `candidate release ${candidate.releaseInstanceId} has no recorded url` };
    }
    return { kind: "available", baseUrl: candidate.url };
  }
}

/** A base-URL resolver hard-bound to ONE candidate's resolved environment for a single probe. */
class FixedBaseUrlResolver implements AcceptanceBaseUrlResolver {
  public constructor(private readonly baseUrl: string) {}
  // eslint-disable-next-line @typescript-eslint/require-await
  public async resolve(): Promise<{ kind: "resolved"; baseUrl: string }> {
    return { kind: "resolved", baseUrl: this.baseUrl };
  }
}

export interface RealCandidateBehaviorReproverDeps {
  /** Compiles the behavior's `behavior_revisions.acceptance` spec into an executable plan. */
  readonly planLoader: AcceptancePlanLoader;
  /** Resolves the environment each candidate is re-proven against (recorded-url in prod). */
  readonly environmentResolver: CandidateEnvironmentResolver;
  /** The request seam; defaults to the platform global `fetch` (injectable for tests). */
  readonly fetchImpl?: HttpFetch;
}

export class RealCandidateBehaviorReprover implements CandidateBehaviorReprover {
  public constructor(private readonly deps: RealCandidateBehaviorReproverDeps) {}

  public async reprove(input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly behaviorRevisionId: string;
    readonly candidate: CandidateRelease;
  }): Promise<BehaviorVerdictOutcome> {
    const plan = await this.loadPlan(input.orgId, input.behaviorRevisionId);
    // The behavior's plan cannot be compiled/loaded ⇒ it cannot be re-proven ⇒ inconclusive
    // (fail-closed). Never a fabricated pass/fail on a candidate whose plan does not compile.
    if (plan === undefined) return "inconclusive_infrastructure";

    const environment = await this.deps.environmentResolver.resolve(input.candidate);
    if (environment.kind === "unavailable") return "inconclusive_infrastructure";

    const orchestrator = new AcceptanceOrchestrator({
      // Non-persisting: the diagnostic re-probe never lands in the production verdict ledger.
      // rv-9: DELIBERATELY no `renderCapture` here. This bisection re-probe records no durable
      // verdict, so content-addressing its captures would write verification_artifacts/cas rows
      // that no durable verdict references (behavior_verdict_evidence) — the exact orphan-CAS
      // class the rv-9 audit flags. Capture belongs only on the ledger-persisting paths.
      store: new EphemeralAcceptanceRunStore(),
      events: new EphemeralAcceptanceEventSink(),
      drivers: [
        new HttpAcceptanceSurfaceDriver({
          resolveBaseUrl: new FixedBaseUrlResolver(environment.baseUrl),
          ...(this.deps.fetchImpl === undefined ? {} : { fetchImpl: this.deps.fetchImpl }),
        }),
      ],
    });
    const runResult = await orchestrator.execute({
      orgId: input.orgId,
      projectId: input.projectId,
      integrationNodeId: input.candidate.integrationNodeId,
      environmentId: `bisection-probe:${input.candidate.releaseInstanceId}`,
      preparedHeadSha: input.candidate.sourceRef,
      jjTreeId: input.candidate.sourceRef,
      artifactDigest: parseDigest(input.candidate.artifactDigest),
      deploymentFingerprint: `bisection:${input.candidate.releaseInstanceId}`,
      purpose: "post_merge_production",
      plans: [plan],
    });
    // The bisector re-proves ONE behavior at a time, so the single behavior result is the probe.
    return runResult.behaviors[0]?.outcome ?? "inconclusive_infrastructure";
  }

  private async loadPlan(orgId: string, behaviorRevisionId: string): Promise<AcceptancePlan | undefined> {
    let plan: AcceptancePlan | undefined;
    try {
      const plans = await this.deps.planLoader.loadPlans({ orgId, behaviorRevisionIds: [behaviorRevisionId] });
      plan = plans[0];
    } catch {
      // A missing revision / malformed spec means the behavior cannot be re-proven against this
      // candidate — `plan` stays undefined so the caller fails closed to an inconclusive probe
      // rather than a fabricated verdict.
    }
    return plan;
  }
}
