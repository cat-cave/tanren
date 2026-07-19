// rv-23 — the six additional proof surfaces beyond the matrix: Behavior detail
// (verdict history), Run detail (assertion timeline), External-effect causality,
// Visual verification (design render), Merge-queue bisection, and Flake/quarantine.
// Each consumes a REAL org-scoped endpoint (rv-22 for the first two, rv-23 for the
// rest) and fails closed: an unresolved surface renders BLOCKED, never green.
import type {
  BehaviorVerdictHistory,
  DesignRenderList,
  EffectCausality,
  FlakeQuarantineList,
  RegressionBisectionList,
  RunDetail,
} from "../../api/proofDashboard.js";
import { OutcomePill, outcomeClass, shortHash, SurfaceUnavailable } from "./helpers.js";
import { PROOF_DASHBOARD_CSS } from "./styles.js";

function Screen(props: { readonly eyebrow: string; readonly title: string; readonly children: unknown }) {
  return (
    <div class="proof">
      <style>{PROOF_DASHBOARD_CSS}</style>
      <section class="panel">
        <div class="panel-pad">
          <div class="eyebrow">{props.eyebrow}</div>
          <h2>{props.title}</h2>
          {props.children}
        </div>
      </section>
    </div>
  );
}

// --- Behavior detail (rv-22 verdict history) ----------------------------------
export function BehaviorDetailBody(props: {
  readonly history: BehaviorVerdictHistory | undefined;
  readonly behaviorRevisionId: string;
  readonly missingProject: boolean;
}) {
  const { history } = props;
  return (
    <Screen eyebrow="runtime verification · behavior detail" title={`Behavior ${props.behaviorRevisionId}`}>
      {history === undefined ? (
        <SurfaceUnavailable missingProject={props.missingProject} what="behavior verdict history" />
      ) : (
        <>
          <p class="sub">
            Latest outcome: <OutcomePill outcome={history.latestOutcome} /> across {history.verdicts.length} recorded
            verdict(s), newest first. Every verdict is shown exactly as persisted.
          </p>
          {history.verdicts.length === 0 ? (
            <div class="empty">No verdicts recorded for this behavior revision — unproven, not passing.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>outcome</th>
                  <th>run purpose</th>
                  <th>assertions</th>
                  <th>flake</th>
                  <th>recorded</th>
                </tr>
              </thead>
              <tbody>
                {history.verdicts.map((v) => (
                  <tr>
                    <td>
                      <OutcomePill outcome={v.verdict.outcome} />
                    </td>
                    <td>{v.runPurpose}</td>
                    <td>
                      <code>
                        {v.verdict.executedAssertionCount}/{v.verdict.requiredAssertionCount}
                      </code>
                    </td>
                    <td>{v.verdict.flakeState}</td>
                    <td class="tl-meta">{v.createdAt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </Screen>
  );
}

// --- Run detail — assertion timeline (rv-22 run detail) -----------------------
export function RunTimelineBody(props: {
  readonly detail: RunDetail | undefined;
  readonly runId: string;
  readonly missingProject: boolean;
}) {
  const { detail } = props;
  return (
    <Screen eyebrow="runtime verification · run assertion timeline" title={`Run ${props.runId}`}>
      {detail === undefined ? (
        <SurfaceUnavailable missingProject={props.missingProject} what="run assertion timeline" />
      ) : (
        <>
          <p class="sub">
            {detail.run.purpose} · {detail.run.status} · latest outcome{" "}
            <OutcomePill outcome={detail.run.latestOutcome} />
          </p>
          <div class="timeline">
            <div class="tl-step">
              <div
                class={`tl-dot ${detail.environment !== null && detail.environment.lifecycleStatus === "ready" ? "pass" : "fail"}`}
              />
              <div>
                <div class="tl-label">verification environment</div>
                <div class="tl-meta">
                  {detail.environment === null
                    ? "no environment binding — the run cannot be trusted as proven"
                    : `${detail.environment.lifecycleStatus} · ${detail.environment.deploymentTarget} · artifact ${shortHash(detail.environment.artifactDigest)}`}
                </div>
              </div>
            </div>
            {detail.verdicts.map((v) => (
              <div class="tl-step">
                <div class={`tl-dot ${outcomeClass(v.outcome)}`} />
                <div>
                  <div class="tl-label">assert · {v.behaviorRevisionId}</div>
                  <div class="tl-meta">
                    <OutcomePill outcome={v.outcome} /> · {v.executedAssertionCount}/{v.requiredAssertionCount}{" "}
                    assertions · {v.gateEffect}
                  </div>
                </div>
              </div>
            ))}
            <div class="tl-step">
              <div class={`tl-dot ${detail.run.latestOutcome === "passed" ? "pass" : "fail"}`} />
              <div>
                <div class="tl-label">verdict</div>
                <div class="tl-meta">
                  {detail.verdicts.length === 0
                    ? "no verdicts — inconclusive, not passing"
                    : `${detail.verdicts.length} verdict(s) · proof bundle ${detail.proofBundleHref}`}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </Screen>
  );
}

// --- External-effect causality viewer -----------------------------------------
export function CausalityBody(props: {
  readonly causality: EffectCausality | undefined;
  readonly missingProject: boolean;
}) {
  const { causality } = props;
  return (
    <Screen eyebrow="runtime verification · external-effect causality" title="External-effect causality">
      {causality === undefined ? (
        <SurfaceUnavailable missingProject={props.missingProject} what="external-effect causality" />
      ) : (
        <>
          <div class="summary">
            <div class="stat">
              <b>{causality.okCount}</b>
              <span>observed ok</span>
            </div>
            <div class="stat">
              <b>{causality.missingCount}</b>
              <span>missing</span>
            </div>
            <div class="stat">
              <b>{causality.duplicateCount}</b>
              <span>duplicate</span>
            </div>
          </div>
          {causality.missingCount > 0 || causality.duplicateCount > 0 ? (
            <div class="alert" role="alert">
              <b>
                {causality.missingCount} missing · {causality.duplicateCount} duplicate
              </b>{" "}
              — the observed provider effects do not match the triggers one-to-one. This is a real causality gap, not a
              pass.
            </div>
          ) : null}
          {causality.observations.length === 0 ? (
            <div class="empty">No provider observations recorded — the external-effect plane is unproven.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>class</th>
                  <th>observer</th>
                  <th>provider</th>
                  <th>trigger</th>
                  <th>object</th>
                  <th>count</th>
                </tr>
              </thead>
              <tbody>
                {causality.observations.map((o) => (
                  <tr>
                    <td>
                      <span class={`pill ${o.classification === "ok" ? "pass" : "fail"}`}>{o.classification}</span>
                    </td>
                    <td>{o.observer}</td>
                    <td>{o.provider}</td>
                    <td>
                      <code>{shortHash(o.triggerIdHash)}</code>
                    </td>
                    <td>
                      <code>{shortHash(o.providerObjectHash)}</code>
                    </td>
                    <td>
                      <code>{o.occurrenceCount}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </Screen>
  );
}

// --- Visual verification workspace (design render) ----------------------------
export function DesignRenderBody(props: {
  readonly list: DesignRenderList | undefined;
  readonly missingProject: boolean;
}) {
  const { list } = props;
  return (
    <Screen eyebrow="runtime verification · visual verification" title="Visual verification">
      {list === undefined ? (
        <SurfaceUnavailable missingProject={props.missingProject} what="visual verification verdicts" />
      ) : list.verdicts.length === 0 ? (
        <div class="empty">No design-render verdicts recorded — the visual plane is unproven.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>outcome</th>
              <th>design system</th>
              <th>standard</th>
              <th>checkpoints</th>
              <th>failing rules</th>
              <th>recorded</th>
            </tr>
          </thead>
          <tbody>
            {list.verdicts.map((v) => (
              <tr>
                <td>
                  <span
                    class={`pill ${v.outcome === "passed" ? "pass" : v.outcome === "not_applicable" ? "unknown" : "fail"}`}
                  >
                    {v.outcome.replaceAll("_", " ")}
                  </span>
                </td>
                <td>
                  <code>{v.designSystemId}</code>
                </td>
                <td>{v.accessibilityStandard}</td>
                <td>
                  <code>
                    {v.passedCount}/{v.checkpointCount}
                  </code>{" "}
                  · {v.failedCount} failed · {v.inconclusiveCount} inconclusive
                </td>
                <td>{v.failingRuleIds.length === 0 ? "—" : v.failingRuleIds.join(", ")}</td>
                <td class="tl-meta">{v.createdAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Screen>
  );
}

// --- Merge-queue view (regression bisections) ---------------------------------
export function BisectionBody(props: {
  readonly list: RegressionBisectionList | undefined;
  readonly missingProject: boolean;
}) {
  const { list } = props;
  return (
    <Screen eyebrow="runtime verification · merge-queue bisection" title="Merge-queue regression bisections">
      {list === undefined ? (
        <SurfaceUnavailable missingProject={props.missingProject} what="regression bisections" />
      ) : list.bisections.length === 0 ? (
        <div class="empty">No behavior-aware regression bisections recorded.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>status</th>
              <th>behavior</th>
              <th>culprit</th>
              <th>candidates / probes</th>
              <th>reason</th>
              <th>recorded</th>
            </tr>
          </thead>
          <tbody>
            {list.bisections.map((b) => (
              <tr>
                <td>
                  <span class={`pill ${b.status === "localized" ? "warn" : "unknown"}`}>{b.status}</span>
                </td>
                <td>
                  <code>{b.behaviorRevisionId}</code>
                </td>
                <td>{b.culpritReleaseInstanceId === null ? "—" : <code>{b.culpritReleaseInstanceId}</code>}</td>
                <td>
                  <code>
                    {b.candidateCount} / {b.probeCount}
                  </code>
                </td>
                <td>{b.inconclusiveReason ?? "—"}</td>
                <td class="tl-meta">{b.createdAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Screen>
  );
}

// --- Flake and quarantine workspace -------------------------------------------
export function QuarantineBody(props: {
  readonly list: FlakeQuarantineList | undefined;
  readonly missingProject: boolean;
}) {
  const { list } = props;
  return (
    <Screen eyebrow="runtime verification · flake & quarantine" title="Flake and quarantine">
      {list === undefined ? (
        <SurfaceUnavailable missingProject={props.missingProject} what="flake quarantine state" />
      ) : list.quarantines.length === 0 ? (
        <div class="empty">No behaviors are quarantined. (An empty quarantine ledger is not a proof of passing.)</div>
      ) : (
        <>
          <p class="sub">
            A quarantined behavior is <b>excluded from green</b>, never counted as passed. Current state is the latest
            transition per behavior.
          </p>
          <table>
            <thead>
              <tr>
                <th>state</th>
                <th>behavior</th>
                <th>classification</th>
                <th>gate effect</th>
                <th>evidence verdicts</th>
                <th>reason</th>
              </tr>
            </thead>
            <tbody>
              {list.quarantines.map((q) => (
                <tr>
                  <td>
                    <span class={`pill ${q.state === "quarantined" ? "warn" : "unknown"}`}>{q.state}</span>
                  </td>
                  <td>
                    <code>{q.behaviorRevisionId}</code>
                  </td>
                  <td>{q.classification}</td>
                  <td>{q.gateEffect}</td>
                  <td>
                    <code>{q.evidenceVerdictCount}</code>
                  </td>
                  <td>{q.reason === "" ? "—" : q.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Screen>
  );
}
