import type { IntegrationEvent } from "../../api/integrationEvents.js";

const INTEGRATION_EVENTS_CSS = `
.integration-events-screen { display: flex; flex-direction: column; gap: 16px; }
.integration-events-screen .panel { border: 1px solid var(--line, #2d3139); background: var(--panel, #17191f); }
.integration-events-screen .panel-pad { padding: 18px; }
.integration-events-screen .eyebrow { color: var(--fg-3, #8b919d); font: 11px var(--font-mono, monospace); text-transform: uppercase; }
.integration-events-screen h1 { margin: 5px 0 0; font-size: 25px; }
.integration-events-screen .event-list { display: flex; flex-direction: column; gap: 10px; }
.integration-events-screen .event { border-top: 1px solid var(--line, #2d3139); padding: 14px 0 4px; }
.integration-events-screen .event:first-child { border-top: 0; padding-top: 0; }
.integration-events-screen .event-head { align-items: baseline; display: flex; flex-wrap: wrap; gap: 10px; }
.integration-events-screen .event-type { color: var(--ember-08, #f2a65a); font: 600 13px var(--font-mono, monospace); }
.integration-events-screen .event-meta { color: var(--fg-3, #8b919d); font: 11px var(--font-mono, monospace); }
.integration-events-screen pre { background: var(--ink, #101217); color: var(--fg-2, #c5cad3); margin: 10px 0 0; overflow-x: auto; padding: 12px; white-space: pre-wrap; }
.integration-events-screen .empty { color: var(--fg-3, #8b919d); }
`;

export interface IntegrationEventsViewerProps {
  events: IntegrationEvent[] | undefined;
  projectId: string;
  projectName: string;
}

function payloadText(payload: unknown): string {
  return JSON.stringify(payload, null, 2) ?? "null";
}

/** Server-rendered, read-only view of the integration event timeline. */
export function IntegrationEventsViewer(props: IntegrationEventsViewerProps) {
  const { events, projectId, projectName } = props;
  return (
    <>
      <style data-screen="integration-events" dangerouslySetInnerHTML={{ __html: INTEGRATION_EVENTS_CSS }} />
      <div class="page-head">
        <div>
          <div class="eyebrow">project · {projectName || projectId} · integration lifecycle</div>
          <h1>Integration events</h1>
        </div>
      </div>
      <div class="page-body">
        <div class="integration-events-screen">
          <section class="panel">
            <div class="panel-pad">
              <div class="eyebrow">Lifecycle and independently observed A3 provider effects</div>
              {events === undefined ? (
                <div class="empty" data-integration-events-unavailable>
                  Integration events unavailable — the orchestrator read failed. No event list is fabricated.
                </div>
              ) : events.length === 0 ? (
                <div class="empty" data-integration-events-empty>
                  No integration events have been recorded for this project.
                </div>
              ) : (
                <div class="event-list" data-integration-events>
                  {events.map((event) => (
                    <article class="event" data-event-type={event.eventType}>
                      <div class="event-head">
                        <span class="event-type">{event.eventType}</span>
                        <span class="event-meta">
                          {event.ts} · id {event.id}
                        </span>
                      </div>
                      <pre>{payloadText(event.payload)}</pre>
                    </article>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
