import type {
  MergeQueueRepairRoute,
  MergeQueueRepairRoutesListResponse,
  RepairRouteDisposition,
} from "../../api/mergeQueueRepairRoutes.js";

export interface RepairRouteLineagePanelProps {
  readonly projection: MergeQueueRepairRoutesListResponse | undefined;
}

const REPAIR_ROUTE_CSS = `
.merge-queue-screen .mq10-list { display: flex; flex-direction: column; gap: 10px; }
.merge-queue-screen .mq10-route {
  border: 1px solid var(--line-1); border-radius: 8px; padding: 12px 14px;
  display: flex; flex-direction: column; gap: 6px;
}
.merge-queue-screen .mq10-state {
  font: 700 11px var(--font-mono); letter-spacing: .05em; text-transform: uppercase; color: var(--fg-2);
}
.merge-queue-screen .mq10-route.respec .mq10-state { color: var(--ember-08); }
.merge-queue-screen .mq10-route.blocked_needs_attention .mq10-state { color: var(--fg-3); }
.merge-queue-screen .mq10-fact { font: 10.5px var(--font-mono); color: var(--fg-3); overflow-wrap: anywhere; }
.merge-queue-screen .mq10-fact b { color: var(--fg-1); }
`;

function dispositionLabel(disposition: RepairRouteDisposition): string {
  switch (disposition) {
    case "repair_in_place":
      return "repair in place · writer rework";
    case "respec":
      return "respec · routed to a different agent";
    case "blocked_needs_attention":
      return "blocked · needs attention (fail-closed)";
    default:
      return disposition;
  }
}

function RepairRoute({ route }: { route: MergeQueueRepairRoute }) {
  return (
    <div class={`mq10-route ${route.disposition}`}>
      <div class="mq10-state">{dispositionLabel(route.disposition)}</div>
      <div class="mq10-fact">
        <b>spec</b> {route.sourceSpecId} · <b>failure</b> {route.failureClass} · <b>magnitude</b> {route.magnitude}
      </div>
      <div class="mq10-fact">
        <b>signature</b> {route.failureSignature}
      </div>
      {route.disposition === "respec" ? (
        <div class="mq10-fact">
          <b>gen</b> {route.respecGeneration} · <b>{route.priorAgentRoute}</b> → <b>{route.nextAgentRoute}</b> ·{" "}
          <b>replacement</b> {route.replacementSpecIds.join(", ") || "—"} · <b>packet</b> {route.packetHash ?? "—"}
        </div>
      ) : null}
    </div>
  );
}

/** mq-10 remediation lineage: every autonomous repair / respec / blocked routing, newest first. */
export function RepairRouteLineagePanel({ projection }: RepairRouteLineagePanelProps) {
  const routes = projection?.repairRoutes ?? [];
  return (
    <section class="panel">
      <style>{REPAIR_ROUTE_CSS}</style>
      <div class="panel-pad">
        <div class="mini-eyebrow">
          autonomous repair · respec lineage <span class="window-tag">(mq-10 · fail-closed)</span>
        </div>
        {projection === undefined ? (
          <div class="empty">Repair-route lineage unavailable — the orchestrator read failed, or no project.</div>
        ) : routes.length === 0 ? (
          <div class="empty">
            No autonomous-repair routings yet. When an isolated member fails deterministically it routes to writer
            rework; a proven fixed point emits a RespecPacketV1; an unclassifiable failure fails closed here.
          </div>
        ) : (
          <div class="mq10-list">
            {routes.map((route) => (
              <RepairRoute route={route} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
