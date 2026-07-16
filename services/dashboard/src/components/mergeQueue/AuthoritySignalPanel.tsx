import type {
  MergeQueueAuthoritySignal,
  MergeQueueAuthoritySignalsListResponse,
} from "../../api/mergeQueueAuthoritySignals.js";

export interface AuthoritySignalPanelProps {
  readonly projection: MergeQueueAuthoritySignalsListResponse | undefined;
}

const AUTHORITY_SIGNAL_CSS = `
.merge-queue-screen .authority-signal-list { display: flex; flex-direction: column; gap: 9px; }
.merge-queue-screen .authority-signal {
  border: 1px solid var(--line-1); border-radius: 8px; padding: 12px 14px;
  display: grid; grid-template-columns: minmax(180px, .7fr) minmax(240px, 1.3fr); gap: 12px;
}
.merge-queue-screen .authority-signal .kind,
.merge-queue-screen .authority-signal .facts { display: flex; flex-direction: column; gap: 4px; }
.merge-queue-screen .authority-signal .state {
  font: 700 11px var(--font-mono); letter-spacing: .05em; text-transform: uppercase; color: var(--ember-08);
}
.merge-queue-screen .authority-signal.infrastructure .state { color: var(--fg-2); }
.merge-queue-screen .authority-signal .fact { font: 10.5px var(--font-mono); color: var(--fg-3); }
.merge-queue-screen .authority-signal .fact b { color: var(--fg-1); }
@media (max-width: 760px) { .merge-queue-screen .authority-signal { grid-template-columns: 1fr; } }
`;

function label(signal: MergeQueueAuthoritySignal): string {
  switch (signal.classification) {
    case "deterministic_policy":
      return "policy block · member-local";
    case "transient_infrastructure":
      return "infrastructure signal · retryable";
    case "needs_product_decision":
      return "product decision required";
    case "unknown_fail_closed":
      return "unknown · fail closed";
  }
  return "unknown · fail closed";
}

function visibleIds(values: ReadonlyArray<string>): string {
  return values.length === 0 ? "none" : values.join(", ");
}

function SignalRow(props: {
  readonly signal: MergeQueueAuthoritySignal;
  readonly eventId: string;
  readonly observedAt: string;
}) {
  const { signal } = props;
  return (
    <div class={`authority-signal ${signal.classification === "transient_infrastructure" ? "infrastructure" : ""}`}>
      <div class="kind">
        <span class="state">{label(signal)}</span>
        <span class="fact">reason · {signal.reasonCode}</span>
        <span class="fact">disposition · {signal.disposition}</span>
        <span class="fact">retryability · {signal.retryability}</span>
      </div>
      <div class="facts">
        <span class="fact">
          members · <b>{visibleIds(signal.memberIds)}</b>
        </span>
        <span class="fact">
          findings · <b>{visibleIds(signal.findingIds)}</b>
        </span>
        <span class="fact">evaluation · {signal.evaluationId}</span>
        <span class="fact">group · {signal.groupId}</span>
        <span class="fact">wake · {signal.wakeKey ?? "none"}</span>
        <span class="fact">
          classified event · {props.eventId} · {props.observedAt}
        </span>
      </div>
    </div>
  );
}

/** Visible, non-green latest-signal read-side; no evaluation ID is user input. */
export function AuthoritySignalPanel(props: AuthoritySignalPanelProps) {
  const signals = props.projection?.signals ?? [];
  return (
    <section class="panel" aria-label="merge authority signals">
      <style data-component="authority-signals" dangerouslySetInnerHTML={{ __html: AUTHORITY_SIGNAL_CSS }} />
      <div class="panel-pad">
        <div class="mini-eyebrow">
          authority signal classification · mq-1 · latest evidence
          {props.projection?.latestEvaluationId === null || props.projection?.latestEvaluationId === undefined
            ? null
            : ` · ${props.projection.latestEvaluationId}`}
        </div>
        {props.projection === undefined ? (
          <div class="empty">
            Authority evidence is unavailable. The merge state remains unknown and fail-closed; absence is never
            interpreted as healthy or transient.
          </div>
        ) : signals.length === 0 ? (
          <div class="empty">
            No classified authority signal has been recorded. The merge state remains unknown and fail-closed.
          </div>
        ) : (
          <div class="authority-signal-list">
            {signals.map(({ eventId, observedAt, signal }) => (
              <SignalRow eventId={eventId} observedAt={observedAt} signal={signal} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
