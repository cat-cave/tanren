/**
 * Notifications matrix against the schema. Fully
 * functional: channels column (all 9 channel kinds), the per-event ×
 * per-channel × severity matrix, an add-channel form, and a weekend-mute
 * toggle per target.
 *
 * Wiring: all 9 channel kinds (ntfy, slack, github_checks, teams, discord,
 * email, twilio, pagerduty, webhook) now have real dispatch adapters. Each
 * delivers once its credentials are configured in the secret store. The
 * `wired` flag stays in the catalog so a future unwired channel can still
 * render its "configured but not yet wired" hint.
 */

import type {
  ChannelKind,
  NotificationDelivery,
  NotificationDeliveryStatus,
  NotificationMatrix,
  NotificationRoute,
  NotificationTarget,
} from "../../api/types.js";
import { PhaseBadge, SevBadge, Toggle } from "./primitives.js";

/** Channel catalog: glyph + phase badge + whether dispatch is wired in v0. */
const CHANNELS: Array<{
  kind: ChannelKind;
  glyph: string;
  label: string;
  phase: "v0" | "p3" | "p4";
  wired: boolean;
}> = [
  { kind: "ntfy", glyph: "▮", label: "ntfy", phase: "v0", wired: true },
  { kind: "slack", glyph: "⌥", label: "slack", phase: "p3", wired: true },
  { kind: "github_checks", glyph: "⌬", label: "github checks", phase: "p3", wired: true },
  { kind: "teams", glyph: "◈", label: "microsoft teams", phase: "p3", wired: true },
  { kind: "discord", glyph: "◉", label: "discord", phase: "p3", wired: true },
  { kind: "email", glyph: "✉", label: "email", phase: "p3", wired: true },
  { kind: "twilio", glyph: "▢", label: "sms · twilio", phase: "p4", wired: true },
  { kind: "pagerduty", glyph: "↘", label: "pagerduty", phase: "p4", wired: true },
  { kind: "webhook", glyph: "↗", label: "webhook · custom", phase: "p4", wired: true },
];

const WIRED_KINDS = new Set<ChannelKind>(CHANNELS.filter((c) => c.wired).map((c) => c.kind));

function routeFor(routes: NotificationRoute[], targetId: string, eventName: string): NotificationRoute | undefined {
  return routes.find((r) => r.targetId === targetId && r.eventName === eventName);
}

function ChannelsColumn(props: { targets: NotificationTarget[] }) {
  const byKind = new Map<ChannelKind, NotificationTarget>();
  for (const target of props.targets) {
    if (target.scope === "org" && !byKind.has(target.channelKind)) byKind.set(target.channelKind, target);
  }
  return (
    <div class="col-card" style="gap:8px">
      <div class="h">
        <span>channels</span>
        <span class="mono-dim" style="margin-left:auto">
          add as many as you need
        </span>
      </div>
      {CHANNELS.map((channel) => {
        const target = byKind.get(channel.kind);
        const configured = target !== undefined;
        return (
          <div class={`row-card ${configured && target?.enabled ? "on" : ""}`}>
            <span class="glyph">{channel.glyph}</span>
            <div>
              <div class="name">{channel.label}</div>
              <div class="desc">{configured ? target?.destination : "not configured"}</div>
              {channel.wired ? null : <div class="unwired">configured but not yet wired (v0)</div>}
            </div>
            <PhaseBadge phase={channel.phase} />
            <span class="mono-dim">{configured && target?.weekendMute ? "wknd-mute" : ""}</span>
            <Toggle
              on={configured ? (target?.enabled ?? false) : false}
              dataAttrs={{
                "data-notif-channel": channel.kind,
                "data-notif-target": target?.id ?? "",
                "data-notif-wired": channel.wired ? "1" : "0",
              }}
            />
          </div>
        );
      })}

      <form
        class="col-card live"
        method="post"
        action="/notifications/targets"
        style="gap:8px;padding:12px;margin-top:4px"
      >
        <div class="h">+ add ntfy target</div>
        <div class="field">
          <label for="label">label</label>
          <input id="label" name="label" placeholder="e.g. cat-cave-alerts" required autocomplete="off" />
        </div>
        <div class="field">
          <label for="destination">ntfy url or topic</label>
          <input
            id="destination"
            name="destination"
            placeholder="https://ntfy.sh/cat-cave-alerts"
            required
            autocomplete="off"
          />
        </div>
        <input type="hidden" name="channelKind" value="ntfy" />
        <div style="display:flex">
          <button type="submit" class="btn primary" style="margin-left:auto">
            save ntfy target
          </button>
        </div>
        <div class="mono-dim">
          all channel kinds dispatch · configure each channel's credentials in the secret store
        </div>
      </form>
    </div>
  );
}

function MatrixGrid(props: { matrix: NotificationMatrix }) {
  // Columns = configured org targets (one per channel kind). Cap to keep the
  // grid legible; if none are configured we still show the ntfy column shape.
  const orgTargets = props.matrix.targets.filter((t) => t.scope === "org");
  const columns = orgTargets.length > 0 ? orgTargets : [];
  const cols = Math.max(1, columns.length);
  // Only render events worth opting into (skip pure-info meta noise rows is a
  // phase-3 nicety; v0 shows the full catalog so nothing is hidden).
  const events = props.matrix.events;
  return (
    <div class="col-card" style="padding:0;overflow:hidden">
      <div class="h" style="padding:12px 16px;border-bottom:1px solid var(--line-1)">
        <span>
          routing · <em>per event</em>
        </span>
        <span class="mono-dim" style="margin-left:auto;color:var(--ember-08)">
          org defaults · devs layer overrides
        </span>
      </div>
      <div class="matrix-head" style={`--matrix-cols:${cols}`}>
        <span>event</span>
        {columns.length > 0 ? (
          columns.map((target) => <span class="matrix-cell">{target.channelKind}</span>)
        ) : (
          <span class="matrix-cell">ntfy</span>
        )}
        <span class="matrix-cell">sev</span>
      </div>
      <div style="max-height:420px;overflow:auto">
        {events.map((event) => (
          <div class="matrix-row" style={`--matrix-cols:${cols}`} data-notif-event={event.eventName}>
            <span>{event.eventName}</span>
            {columns.length > 0 ? (
              columns.map((target) => {
                const route = routeFor(props.matrix.routes, target.id, event.eventName);
                const on = route?.enabled === true;
                // Each cell is a tiny form so it persists with zero client JS.
                return (
                  <div class="matrix-cell">
                    <form method="post" action="/notifications/routes" style="margin:0">
                      <input type="hidden" name="targetId" value={target.id} />
                      <input type="hidden" name="eventName" value={event.eventName} />
                      <input type="hidden" name="minSeverity" value={event.defaultSeverity} />
                      <input type="hidden" name="enabled" value={on ? "false" : "true"} />
                      <button
                        type="submit"
                        class={`matrix-check ${on ? "on" : ""}`}
                        title={
                          WIRED_KINDS.has(target.channelKind)
                            ? "toggle opt-in"
                            : "opt-in persists; channel not wired in v0"
                        }
                      >
                        {on ? "✓" : ""}
                      </button>
                    </form>
                  </div>
                );
              })
            ) : (
              <div class="matrix-cell">
                <span class="matrix-check" title="add an ntfy target first"></span>
              </div>
            )}
            <span class="matrix-cell">
              <SevBadge severity={event.defaultSeverity} />
            </span>
          </div>
        ))}
      </div>
      <div
        class="mono-dim"
        style="padding:10px 16px;border-top:1px solid var(--line-1);background:var(--bg-sunken);display:flex;justify-content:space-between"
      >
        <span>events sourced from the P2A-0007 registry · severities from P2A-0017</span>
        <span>weekend auto-mute · per-target</span>
      </div>
    </div>
  );
}

function deliveryStatusClass(status: NotificationDeliveryStatus): "ok" | "warn" | "fail" | "cold" {
  if (status === "sent") return "ok";
  if (status === "failed" || status === "undelivered_no_route") return "fail";
  if (status === "stubbed") return "warn";
  return "cold";
}

function deliveryTitle(delivery: NotificationDelivery): string {
  return delivery.title ?? delivery.eventName ?? "notification event";
}

function deliveryTargetLabel(delivery: NotificationDelivery): string {
  if (delivery.status === "undelivered_no_route") return "no route";
  return delivery.target?.label ?? delivery.target?.channelKind ?? delivery.channel;
}

function deliveryTime(value: string | null): string {
  if (value === null) return "queued";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    day: "numeric",
  })
    .format(date)
    .toLowerCase();
}

function QuietHoursPanel(props: { targets: NotificationTarget[] }) {
  const mutedTargets = props.targets.filter((target) => target.weekendMute);
  return (
    <div class="col-card" style="gap:8px">
      <div class="h">
        <span>
          quiet <em>posture</em>
        </span>
        <span class="mono-dim" style="margin-left:auto">
          persisted per target
        </span>
      </div>
      <div class="sunken">
        <div class="section-label">weekend mute</div>
        <div class="mono" style="margin-top:4px">
          {mutedTargets.length > 0
            ? `${mutedTargets.length} target${mutedTargets.length === 1 ? "" : "s"} mute non-critical delivery on weekends`
            : "no targets have weekend mute enabled"}
        </div>
        <div class="mono-dim" style="margin-top:4px">
          hard-fail and budget-cap events still route according to their severity floor.
        </div>
      </div>
      {mutedTargets.length > 0 ? (
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          {mutedTargets.map((target) => (
            <span class="pill hot">
              <span class="d"></span>
              {target.label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DeliveryHistory(props: { deliveries: NotificationDelivery[] }) {
  return (
    <div class="col-card" style="padding:0;overflow:hidden">
      <div class="h" style="padding:12px 16px;border-bottom:1px solid var(--line-1)">
        <span>
          delivery <em>history</em>
        </span>
        <span class="mono-dim" style="margin-left:auto">
          latest dispatch ledger
        </span>
      </div>
      <div class="delivery-head">
        <span>queued</span>
        <span>event</span>
        <span>target</span>
        <span>status</span>
        <span>sev</span>
      </div>
      <div style="max-height:280px;overflow:auto">
        {props.deliveries.length > 0 ? (
          props.deliveries.map((delivery) => (
            <div class="delivery-row">
              <span class="mono-dim">{deliveryTime(delivery.enqueuedAt)}</span>
              <span>
                <span class="name">{deliveryTitle(delivery)}</span>
                <span class="desc">
                  {delivery.eventName ?? "unknown event"}
                  {delivery.reason === null ? "" : ` · ${delivery.reason}`}
                </span>
              </span>
              <span class="mono-dim">{deliveryTargetLabel(delivery)}</span>
              <span class={`pill ${deliveryStatusClass(delivery.status)}`}>
                <span class="d"></span>
                {delivery.status}
              </span>
              <span class="matrix-cell">
                {delivery.severity === null ? (
                  <span class="mono-dim">n/a</span>
                ) : (
                  <SevBadge severity={delivery.severity} />
                )}
              </span>
            </div>
          ))
        ) : (
          <div class="empty-state">no notification deliveries recorded yet</div>
        )}
      </div>
    </div>
  );
}

export interface NotificationsBodyProps {
  matrix: NotificationMatrix;
  deliveries: NotificationDelivery[];
  notice?: string;
}

/** The full notifications matrix surface. Reused by org-setup step 3 + /notifications. */
export function NotificationsBody(props: NotificationsBodyProps) {
  return (
    <>
      {props.notice ? <div class="alert ok">{props.notice}</div> : null}
      <div class="cols-narrow">
        <ChannelsColumn targets={props.matrix.targets} />
        <MatrixGrid matrix={props.matrix} />
      </div>
      <div class="cols-narrow">
        <QuietHoursPanel targets={props.matrix.targets} />
        <DeliveryHistory deliveries={props.deliveries} />
      </div>
    </>
  );
}
