import type { LandGroupDeliveryListResponse, LandGroupDeliverySummary } from "../../api/mergeQueueGroupDelivery.js";

export interface GroupDeliveryTimelinePanelProps {
  /** mq-13 land-group delivery projection (undefined when the read failed / no project). */
  readonly projection: LandGroupDeliveryListResponse | undefined;
  readonly orgId: string;
  readonly projectId: string;
}

const GROUP_DELIVERY_CSS = `
.merge-queue-screen .mqd-list { display: flex; flex-direction: column; gap: 10px; }
.merge-queue-screen .mqd-row {
  border: 1px solid var(--line-1); border-radius: 8px; padding: 13px 14px;
  display: flex; flex-direction: column; gap: 10px;
}
.merge-queue-screen .mqd-head {
  display: grid; grid-template-columns: minmax(190px, .8fr) minmax(260px, 1.2fr); gap: 12px;
}
.merge-queue-screen .mqd-col { display: flex; flex-direction: column; gap: 4px; }
.merge-queue-screen .mqd-state {
  font: 700 11px var(--font-mono); letter-spacing: .05em; text-transform: uppercase;
}
.merge-queue-screen .mqd-state.ok { color: var(--ember-08); }
.merge-queue-screen .mqd-state.warn { color: var(--fg-2); }
.merge-queue-screen .mqd-fact { font: 10.5px var(--font-mono); color: var(--fg-3); overflow-wrap: anywhere; }
.merge-queue-screen .mqd-fact b { color: var(--fg-1); }
.merge-queue-screen .mqd-timeline { display: flex; gap: 14px; flex-wrap: wrap; }
.merge-queue-screen .mqd-action {
  font: 10.5px var(--font-mono); color: var(--fg-2); text-decoration: underline; overflow-wrap: anywhere;
}
@media (max-width: 760px) { .merge-queue-screen .mqd-head { grid-template-columns: 1fr; } }
`;

function deliveryHref(orgId: string, projectId: string, landGroupId: string): string {
  return (
    `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}` +
    `/merge-queue/land-groups/${encodeURIComponent(landGroupId)}/delivery`
  );
}

function stateClass(state: string): string {
  return state === "completed" ? "ok" : "warn";
}

function DeliveryRow(props: { delivery: LandGroupDeliverySummary; orgId: string; projectId: string }) {
  const { delivery } = props;
  return (
    <article class="mqd-row" data-land-group={delivery.landGroupId}>
      <div class="mqd-head">
        <div class="mqd-col">
          <span class={`mqd-state ${stateClass(delivery.state)}`}>
            group delivery · {delivery.state} · {delivery.disposition}
          </span>
          <span class="mqd-fact">
            land group · <b>{delivery.landGroupId}</b>
          </span>
          <span class="mqd-fact">
            main sha · <b>{delivery.mainSha}</b>
          </span>
          <span class="mqd-fact">receipt · {delivery.receipt === null ? "unavailable" : delivery.id}</span>
        </div>
        <div class="mqd-col">
          <span class="mqd-fact">artifact · {delivery.artifactDigest ?? "—"}</span>
          <span class="mqd-fact">preview release · {delivery.previewReleaseInstanceId ?? "—"}</span>
          <span class="mqd-fact">production release · {delivery.productionReleaseInstanceId ?? "—"}</span>
          <span class="mqd-fact">rollback release · {delivery.rollbackReleaseInstanceId ?? "—"}</span>
          <span class="mqd-fact">updated · {delivery.updatedAt}</span>
        </div>
      </div>
      <div class="mqd-timeline">
        <span class="mqd-fact">
          attributed run · <b>{delivery.attributedRunId ?? "—"}</b>
        </span>
      </div>
      <a class="mqd-action" href={deliveryHref(props.orgId, props.projectId, delivery.landGroupId)}>
        view delivery receipt
      </a>
    </article>
  );
}

/** Visible mq-13 projection. Missing evidence is explicitly unknown, never green. */
export function GroupDeliveryTimelinePanel(props: GroupDeliveryTimelinePanelProps) {
  const deliveries = props.projection?.deliveries ?? [];
  return (
    <section class="panel" aria-label="land group delivery timeline">
      <style data-component="group-delivery" dangerouslySetInnerHTML={{ __html: GROUP_DELIVERY_CSS }} />
      <div class="panel-pad">
        <div class="mini-eyebrow">group delivery · mq-13 · deploy / verify / demo / rollback</div>
        {props.projection === undefined ? (
          <div class="empty">
            Land-group delivery evidence is unavailable — the orchestrator read failed. An unavailable read is never a
            delivery; the state stays unknown, not green.
          </div>
        ) : deliveries.length === 0 ? (
          <div class="empty">
            No completed land group has run its delivery loop yet. A delivery completes only after the group's preview
            verification, proof-backed demo, promotion, and production demo all pass; until then it is unknown, never
            green.
          </div>
        ) : (
          <div class="mqd-list">
            {deliveries.map((delivery) => (
              <DeliveryRow delivery={delivery} orgId={props.orgId} projectId={props.projectId} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
