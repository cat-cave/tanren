import type {
  MergeQueueAuthoritySignal,
  MergeQueueAuthoritySignalsResponse,
} from "../../api/mergeQueueAuthoritySignals.js";

export interface AuthoritySignalPanelProps {
  evaluationId: string | undefined;
  projection: MergeQueueAuthoritySignalsResponse | undefined;
}

const AUTHORITY_SIGNAL_CSS = `
.merge-queue-screen .authority-signal-list { display: flex; flex-direction: column; gap: 9px; }
.merge-queue-screen .authority-signal {
  border: 1px solid var(--line-1); border-radius: 8px; padding: 12px 14px;
  display: grid; grid-template-columns: minmax(170px, .7fr) minmax(220px, 1.3fr); gap: 12px;
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
      return "infrastructure signal";
    case "needs_product_decision":
      return "product decision required";
    case "unknown_fail_closed":
      return "unknown · fail closed";
  }
  return "unknown · fail closed";
}

function visibleIds(values: string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}

function SignalRow(props: { signal: MergeQueueAuthoritySignal; eventId: string; observedAt: string }) {
  const { signal } = props;
  return (
    <div class={`authority-signal ${signal.classification === "transient_infrastructure" ? "infrastructure" : ""}`}>
      <div class="kind">
        <span class="state">{label(signal)}</span>
        <span class="fact">reason · {signal.reasonCode}</span>
        <span class="fact">retryability · {signal.retryability}</span>
      </div>
      <div class="facts">
        <span class="fact">
          members · <b>{visibleIds(signal.memberIds)}</b>
        </span>
        <span class="fact">
          findings · <b>{visibleIds(signal.findingIds)}</b>
        </span>
        <span class="fact">group · {signal.groupId}</span>
        <span class="fact">source event · {signal.sourceEventId ?? "not supplied"}</span>
        <span class="fact">
          classified event · {props.eventId} · {props.observedAt}
        </span>
      </div>
    </div>
  );
}

/** Visible, non-green read-side for all closed mq-1 signal states. */
export function AuthoritySignalPanel(props: AuthoritySignalPanelProps) {
  const signals = props.projection?.signals ?? [];
  return (
    <section class="panel">
      <style data-component="authority-signals" dangerouslySetInnerHTML={{ __html: AUTHORITY_SIGNAL_CSS }} />
      <div class="panel-pad">
        <div class="mini-eyebrow">authority signal classification · mq-1 · evidence</div>
        {props.evaluationId === undefined ? (
          <div class="empty">
            No evaluation selected. Add <b>?evaluationId=&lt;id&gt;</b> to inspect durable merge-authority evidence;
            absence is unclassified, never treated as healthy or transient.
          </div>
        ) : signals.length === 0 ? (
          <div class="empty">
            No classified signal is visible for evaluation <b>{props.evaluationId}</b>. The state remains unknown and
            fail-closed.
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
