import type {
  MergeQueueAuthorityEvaluation,
  MergeQueueAuthorityEvaluationsListResponse,
  MultiMemberAuthorityKind,
} from "../../api/mergeQueueAuthorityEvaluations.js";

export interface MultiMemberAuthorityPanelProps {
  readonly projection: MergeQueueAuthorityEvaluationsListResponse | undefined;
}

const MULTI_MEMBER_AUTHORITY_CSS = `
.merge-queue-screen .mq2-evaluation-list { display: flex; flex-direction: column; gap: 10px; }
.merge-queue-screen .mq2-evaluation {
  border: 1px solid var(--line-1); border-radius: 8px; padding: 13px 14px;
  display: flex; flex-direction: column; gap: 10px;
}
.merge-queue-screen .mq2-evaluation-head {
  display: grid; grid-template-columns: minmax(190px, .7fr) minmax(260px, 1.3fr); gap: 12px;
}
.merge-queue-screen .mq2-kind, .merge-queue-screen .mq2-facts,
.merge-queue-screen .mq2-member { display: flex; flex-direction: column; gap: 4px; }
.merge-queue-screen .mq2-state {
  font: 700 11px var(--font-mono); letter-spacing: .05em; text-transform: uppercase; color: var(--fg-2);
}
.merge-queue-screen .mq2-evaluation.authorized .mq2-state,
.merge-queue-screen .mq2-member.admit .mq2-member-disposition { color: var(--ember-08); }
.merge-queue-screen .mq2-evaluation.unknown .mq2-state { color: var(--fg-3); }
.merge-queue-screen .mq2-summary { font: 11.5px var(--font-ui); color: var(--fg-2); line-height: 1.4; }
.merge-queue-screen .mq2-fact { font: 10.5px var(--font-mono); color: var(--fg-3); overflow-wrap: anywhere; }
.merge-queue-screen .mq2-fact b { color: var(--fg-1); }
.merge-queue-screen .mq2-members { display: flex; flex-direction: column; gap: 6px; }
.merge-queue-screen .mq2-member {
  border-top: 1px solid var(--line-1); padding-top: 8px;
  display: grid; grid-template-columns: minmax(155px, .55fr) minmax(260px, 1.45fr); gap: 10px;
}
.merge-queue-screen .mq2-member-disposition {
  font: 700 10px var(--font-mono); letter-spacing: .04em; text-transform: uppercase; color: var(--fg-2);
}
.merge-queue-screen .mq2-no-members {
  border-top: 1px solid var(--line-1); padding-top: 8px; font: 11px var(--font-ui); color: var(--fg-3);
}
@media (max-width: 760px) {
  .merge-queue-screen .mq2-evaluation-head, .merge-queue-screen .mq2-member { grid-template-columns: 1fr; }
}
`;

function kindLabel(kind: MultiMemberAuthorityKind): string {
  switch (kind) {
    case "authorized_subset":
      return "authorized · exact full node";
    case "member_failure":
      return "member failure · attributed";
    case "interaction_failure":
      return "interaction failure · hold";
    case "flake_observation":
      return "flake observation · same tree";
    case "transient_infrastructure":
      return "infrastructure · retryable";
    case "needs_product_decision":
      return "product decision required";
    case "unknown_fail_closed":
      return "unknown · fail closed";
  }
  return "unknown · fail closed";
}

function kindSummary(kind: MultiMemberAuthorityKind): string {
  switch (kind) {
    case "authorized_subset":
      return "Durable authority evidence admits every member of this exact persisted node.";
    case "member_failure":
      return "Attributed failures are withheld; any eligible sibling still needs fresh per-member authorization.";
    case "interaction_failure":
      return "The exact combined-node gate failed. No member blame is assigned before the existing bisect.";
    case "flake_observation":
      return "Typed non-determinism was observed on one tree and quarantine epoch. It assigns no member blame.";
    case "transient_infrastructure":
      return "Typed infrastructure evidence holds the node for the existing retry path.";
    case "needs_product_decision":
      return "The node remains held until its durable product-decision wake condition changes.";
    case "unknown_fail_closed":
      return "Evidence is incomplete or contradictory. No member is admitted by uncertainty.";
  }
  return "Evidence is incomplete or contradictory. No member is admitted by uncertainty.";
}

function tone(kind: MultiMemberAuthorityKind): string {
  if (kind === "authorized_subset") return "authorized";
  if (kind === "unknown_fail_closed") return "unknown";
  return "blocked";
}

function visibleIds(values: ReadonlyArray<string>): string {
  return values.length === 0 ? "none recorded" : values.join(", ");
}

function durableValue(value: string | null): string {
  return value ?? "not durably linked";
}

function EvaluationRow(props: { readonly evaluation: MergeQueueAuthorityEvaluation }) {
  const { evaluation } = props;
  return (
    <article class={`mq2-evaluation ${tone(evaluation.kind)}`} data-authority-kind={evaluation.kind}>
      <div class="mq2-evaluation-head">
        <div class="mq2-kind">
          <span class="mq2-state">{kindLabel(evaluation.kind)}</span>
          <span class="mq2-summary">{kindSummary(evaluation.kind)}</span>
          <span class="mq2-fact">
            reasons · <b>{visibleIds(evaluation.reasonCodes)}</b>
          </span>
          <span class="mq2-fact">
            aggregate findings · <b>{visibleIds(evaluation.findingIds)}</b>
          </span>
          <span class="mq2-fact">
            eligible for fresh authority · <b>{visibleIds(evaluation.eligibleMemberIds)}</b>
          </span>
        </div>
        <div class="mq2-facts">
          <span class="mq2-fact">evaluation · {evaluation.evaluationId}</span>
          <span class="mq2-fact">group · {evaluation.groupId}</span>
          <span class="mq2-fact">node · {durableValue(evaluation.nodeId)}</span>
          <span class="mq2-fact">member set · {durableValue(evaluation.memberSetHash)}</span>
          <span class="mq2-fact">proof · {durableValue(evaluation.proofReuseKey)}</span>
          <span class="mq2-fact">
            durable source · {evaluation.source} · {evaluation.sourceId}
          </span>
          <span class="mq2-fact">observed · {evaluation.observedAt}</span>
        </div>
      </div>
      {evaluation.members.length === 0 ? (
        <div class="mq2-no-members">No durably linked member outcome is available. Absence admits no member.</div>
      ) : (
        <div class="mq2-members" aria-label="ordered member outcomes">
          {evaluation.members.map((member) => (
            <div class={`mq2-member ${member.disposition}`}>
              <div class="mq2-kind">
                <span class="mq2-member-disposition">
                  member {member.ordinal + 1} · {member.disposition}
                </span>
                <span class="mq2-fact">
                  spec · <b>{member.specId}</b>
                </span>
                <span class="mq2-fact">run · {durableValue(member.runId)}</span>
              </div>
              <div class="mq2-facts">
                <span class="mq2-fact">branch · {durableValue(member.branch)}</span>
                <span class="mq2-fact">head · {durableValue(member.headSha)}</span>
                <span class="mq2-fact">reasons · {visibleIds(member.reasonCodes)}</span>
                <span class="mq2-fact">findings · {visibleIds(member.findingIds)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

/** Visible durable MQ-2 projection. Missing evidence is explicitly fail-closed, never green. */
export function MultiMemberAuthorityPanel(props: MultiMemberAuthorityPanelProps) {
  const evaluations = props.projection?.evaluations ?? [];
  return (
    <section class="panel" aria-label="multi-member merge authority">
      <style data-component="multi-member-authority" dangerouslySetInnerHTML={{ __html: MULTI_MEMBER_AUTHORITY_CSS }} />
      <div class="panel-pad">
        <div class="mini-eyebrow">
          exact multi-member merge authority · mq-2 · durable evidence
          {props.projection?.latestEvaluationId === null || props.projection?.latestEvaluationId === undefined
            ? null
            : ` · ${props.projection.latestEvaluationId}`}
        </div>
        {props.projection === undefined ? (
          <div class="empty">
            Multi-member authority evidence is unavailable. The exact node remains unknown and fail-closed; an
            unavailable read is never authorization.
          </div>
        ) : evaluations.length === 0 ? (
          <div class="empty">
            No durable multi-member authority evaluation has been recorded. The exact node remains unknown and
            fail-closed; empty state is never green.
          </div>
        ) : (
          <div class="mq2-evaluation-list">
            {evaluations.map((evaluation) => (
              <EvaluationRow evaluation={evaluation} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
