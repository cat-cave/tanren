import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import type { TypedEvent } from "../events/index.js";
import { redactEventPayload } from "../redaction/index.js";
import type { NotificationChannel } from "./channels/types.js";
import { evaluateMatrix, isWeekendInUtc, type MatrixContext } from "./matrix.js";
import { bodyFor, effectiveSeverityFor, errorMessage, titleFor, type EventContext } from "./messageFormat.js";
import {
  NotificationDispatchLog,
  NotificationRouteStore,
  NotificationTargetStore,
  type DispatchLogInput,
  type DispatchStatus,
} from "./store.js";
import {
  type ChannelKind,
  type NotificationPayload,
  NotificationPayload as NotificationPayloadSchema,
  type NotificationTargetRow,
  type Severity,
  severityMeetsFloor,
} from "./schemas.js";
import { createLogger } from "../observability/logger.js";

// dispatcher.
//
// Flow per event:
//   1. Resolve the event's effective severity (default-map + a few
//      per-payload promotions, e.g. a run.completed whose outcome contains
//      "fail" promotes one tier so the matrix's `warn` floor catches it).
//   2. Load applicable matrix context (targets + routes for this event,
//      scoped to the org). The dispatcher is given an `orgId` per event —
//      `null` events skip notifications entirely.
//   3. Evaluate the matrix (matrix.ts).
//   4. For each match:
//        a. Apply weekend mute if target.weekendMute && weekend.
//        b. Redact the payload through the redaction layer against a `system-actor`
//           that holds only `project:member`. Channels (especially the
//           future slack/webhook adapters) MUST NOT receive raw bytes —
//           the safest scope is "project:member" so even `redacted`
//           fields render as the public marker.
//        c. Build a NotificationPayload (title/body/severity/url/tags).
//        d. Invoke the channel's publish(). Catch failures; never raise.
//        e. Record the dispatch in the `notifications` log: `sent` for
//           a wired channel that returned, `failed` for a wired channel
//           that threw, `stubbed` for an unwired channel.

export interface DispatcherDeps {
  query: pg.Pool | pg.PoolClient;
  channels: Record<ChannelKind, NotificationChannel>;
  // Optional now() override for tests. The dispatcher consults this for
  // weekend-mute. Defaults to `() => new Date()`.
  now?: () => Date;
  // Optional logger; defaults to console. We never throw on logging.
  log?: (level: "info" | "warn" | "error", message: string, meta?: Record<string, unknown>) => void;
  // Optional deep-link builder for the matrix UI's "view run" affordance.
  // Receives the event and returns a URL or undefined.
  urlFor?: (event: TypedEvent, context: EventContext) => string | undefined;
  // Code-level DEFAULT ROUTE (the "never silently drop a fail-severity event"
  // guarantee). Delivers to a fallback channel when NO per-org route matched;
  // per-org routes always take precedence. When absent, a fail-severity event
  // with no route emits a LOUD log AND a durable `undelivered_no_route` ledger
  // row (Codex H3 #19) — never a silent drop.
  defaultRoute?: DefaultRoute;
}

export interface DefaultRoute {
  // The channel kind the default fallback delivers through. Must be a kind the
  // dispatcher's channel registry knows (it is, since the registry is built
  // with one adapter per kind).
  channelKind: ChannelKind;
  // The channel destination (a credential ref or a verbatim URL — channel-
  // specific, exactly as a target row's `destination`).
  destination: string;
  // The minimum effective severity that triggers the default route when no
  // configured route matched. Defaults to `warn` so routine info/ok lifecycle
  // events never reach a human via the default (no spam) while every
  // warn/fail escalation does.
  minSeverity?: Severity;
}

export type { EventContext } from "./messageFormat.js";

// system-actor: the redactor needs an ActorContext, and notifications fan
// out to potentially untrusted external sinks (slack/webhook). We give the
// system actor the lowest scope so even `redacted`-tagged fields render as
// markers in the published body.
const SYSTEM_ACTOR: ActorContext = {
  userId: "system:notifications",
  orgId: null,
  projectId: null,
  scopes: ["project:member"],
  source: "local_dev",
};

export class NotificationDispatcher {
  private readonly query: DispatcherDeps["query"];
  private readonly channels: Record<ChannelKind, NotificationChannel>;
  private readonly now: () => Date;
  private readonly log: NonNullable<DispatcherDeps["log"]>;
  private readonly urlFor: DispatcherDeps["urlFor"];
  private readonly defaultRoute: DispatcherDeps["defaultRoute"];

  constructor(deps: DispatcherDeps) {
    this.query = deps.query;
    this.channels = deps.channels;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? defaultLog;
    this.urlFor = deps.urlFor;
    this.defaultRoute = deps.defaultRoute;
  }

  async onEvent(event: TypedEvent, context: EventContext): Promise<void> {
    if (context.orgId === null) return;

    const severity = effectiveSeverityFor(event);

    const matrix = await this.loadMatrixContext({
      orgId: context.orgId,
      eventName: event.eventType,
      actorUserId: context.actorUserId,
    });

    const matches = evaluateMatrix({
      ...matrix,
      eventName: event.eventType,
      effectiveSeverity: severity,
    });

    if (matches.length === 0) {
      await this.handleNoMatch(event, context, severity);
      return;
    }

    const now = this.now();
    const weekend = isWeekendInUtc(now);

    for (const match of matches) {
      try {
        if (match.target.weekendMute && weekend) {
          await this.recordDispatch({
            orgId: context.orgId,
            channel: match.target.channelKind,
            payload: {
              eventName: event.eventType,
              targetId: match.target.id,
              reason: "weekend_mute",
            },
            status: "skipped",
            attempts: 0,
            sentAt: null,
          });
          continue;
        }

        const payload = this.buildPayload(event, context, severity);

        const channel = this.channels[match.target.channelKind];
        // Defense-in-depth: a target row whose channelKind has no
        // registered adapter at all should still log a row so the audit
        // trail is complete. In practice the dispatcher is constructed
        // with one entry per ChannelKind, but registries can drift.
        if (channel === undefined) {
          await this.recordDispatch({
            orgId: context.orgId,
            channel: match.target.channelKind,
            payload: {
              eventName: event.eventType,
              targetId: match.target.id,
              reason: "no_adapter",
            },
            status: "skipped",
            attempts: 0,
            sentAt: null,
          });
          continue;
        }

        const status = await this.invokeChannel(channel, match.target, payload);
        await this.recordDispatch({
          orgId: context.orgId,
          channel: match.target.channelKind,
          payload: {
            eventName: event.eventType,
            targetId: match.target.id,
            layering: match.layering,
            severity,
            title: payload.title,
          },
          status,
          attempts: 1,
          sentAt: status === "sent" ? now : null,
        });
      } catch (caught) {
        // We never propagate dispatcher failures. The catch is the outer
        // safety net for unexpected throws (e.g. log writer failed).
        this.log("error", "notification dispatcher swallowed unexpected error", {
          eventName: event.eventType,
          targetId: match.target.id,
          error: errorMessage(caught),
        });
      }
    }
  }

  /**
   * No configured route matched this event. Never silently drop a genuine
   * escalation: if the event's effective severity meets the default route's
   * floor (default `warn`) we deliver to the code-level default channel when
   * one is configured; otherwise we emit a LOUD log AND persist a durable
   * `undelivered_no_route` row in the notifications ledger (Codex H3 Surface 6
   * #19) so the operator sees the missing-route escalation on the deliveries
   * API. A routine sub-floor event returns quietly (no-spam contract).
   */
  private async handleNoMatch(event: TypedEvent, context: EventContext, severity: Severity): Promise<void> {
    const floor = this.defaultRoute?.minSeverity ?? "warn";
    if (!severityMeetsFloor(severity, floor)) return;

    if (this.defaultRoute === undefined) {
      // Two surfaces so the operator cannot miss it: LOUD log for stderr /
      // observability + a durable `undelivered_no_route` row (Codex H3 #19).
      this.log("error", "no notification route configured for a fail-severity event", {
        eventName: event.eventType,
        severity,
        orgId: context.orgId,
        specId: context.specId ?? null,
        runId: context.runId ?? null,
      });
      if (context.orgId !== null) {
        await this.recordDispatch({
          orgId: context.orgId,
          channel: "no_route",
          payload: {
            eventName: event.eventType,
            severity,
            reason: "no_route",
            layering: "no_route",
            specId: context.specId ?? null,
            runId: context.runId ?? null,
            projectId: context.projectId ?? null,
            title: `[${severity.toUpperCase()}] ${event.eventType}`,
          },
          status: "undelivered_no_route",
          attempts: 0,
          sentAt: null,
        });
      }
      return;
    }

    const route = this.defaultRoute;
    if (context.orgId === null) {
      throw new Error("notification default-route dispatch requires an org id");
    }
    const orgId = context.orgId;
    const target = this.buildDefaultTarget(route, orgId);
    const channel = this.channels[route.channelKind];
    if (channel === undefined) {
      // The default route names a kind the registry has no adapter for. Loud,
      // not silent — the escalation still failed to reach a human.
      this.log("error", "default notification route names an unregistered channel kind", {
        eventName: event.eventType,
        channelKind: route.channelKind,
        severity,
      });
      return;
    }
    try {
      const payload = this.buildPayload(event, context, severity);
      const status = await this.invokeChannel(channel, target, payload);
      await this.recordDispatch({
        orgId,
        channel: route.channelKind,
        payload: {
          eventName: event.eventType,
          targetId: target.id,
          layering: "default_route",
          severity,
          title: payload.title,
        },
        status,
        attempts: 1,
        sentAt: status === "sent" ? this.now() : null,
      });
    } catch (caught) {
      this.log("error", "notification dispatcher swallowed unexpected error on the default route", {
        eventName: event.eventType,
        channelKind: route.channelKind,
        error: errorMessage(caught),
      });
    }
  }

  /** Build the synthetic org-scoped target the default route delivers through. */
  private buildDefaultTarget(route: DefaultRoute, orgId: string): NotificationTargetRow {
    const now = this.now();
    return {
      id: "notif_target_default",
      orgId,
      scope: "org",
      userId: null,
      channelKind: route.channelKind,
      destination: route.destination,
      // The default route carries no per-target base URL: an ntfy default with a
      // bare-topic destination resolves against the deploy default injected at
      // boot (null ⇒ use the deploy default).
      baseUrl: null,
      label: "default route",
      enabled: true,
      // The default route never weekend-mutes: a fail-severity escalation must
      // land regardless of the day.
      weekendMute: false,
      createdAt: now,
      updatedAt: now,
    };
  }

  private async loadMatrixContext(args: {
    orgId: string;
    eventName: string;
    actorUserId: string | null;
  }): Promise<MatrixContext> {
    const [targets, routes] = await Promise.all([
      NotificationTargetStore.listForOrg(this.query, args.orgId),
      NotificationRouteStore.listForOrgEvent(this.query, {
        orgId: args.orgId,
        eventName: args.eventName,
      }),
    ]);
    return { targets, routes, actorUserId: args.actorUserId };
  }

  private async invokeChannel(
    channel: NotificationChannel,
    target: NotificationTargetRow,
    payload: NotificationPayload,
  ): Promise<DispatchStatus> {
    if (!channel.wired) {
      try {
        await channel.publish(target, payload);
      } catch (caught) {
        // Unwired channels MUST NOT throw; log defensively and return
        // stubbed so the operator sees an actionable diagnostic if a
        // stub regresses.
        this.log("warn", "stub channel threw", {
          channel: channel.kind,
          error: errorMessage(caught),
        });
      }
      return "stubbed";
    }
    try {
      await channel.publish(target, payload);
      return "sent";
    } catch (caught) {
      this.log("warn", "channel publish failed", {
        channel: channel.kind,
        targetId: target.id,
        error: errorMessage(caught),
      });
      return "failed";
    }
  }

  private buildPayload(event: TypedEvent, context: EventContext, severity: Severity): NotificationPayload {
    const redacted = redactEventPayload({
      eventName: event.eventType,
      payload: event.payload,
      actor: SYSTEM_ACTOR,
    });
    const title = titleFor(event.eventType, severity);
    const body = bodyFor(event.eventType, context, redacted.payload);
    const url = this.urlFor ? this.urlFor(event, context) : undefined;
    return NotificationPayloadSchema.parse({
      title,
      body,
      severity,
      eventName: event.eventType,
      ...(url === undefined ? {} : { url }),
      tags: ["tanren", `severity:${severity}`],
    });
  }

  private async recordDispatch(input: DispatchLogInput): Promise<void> {
    try {
      await NotificationDispatchLog.record(this.query, input);
    } catch (caught) {
      // The dispatch ledger is best-effort. A write failure here would
      // mean Postgres is unreachable; nothing the dispatcher can do but
      // surface a log line.
      this.log("error", "failed to write notification dispatch log row", {
        error: errorMessage(caught),
      });
    }
  }
}

const dispatcherLogger = createLogger("notifications");

function defaultLog(level: "info" | "warn" | "error", message: string, meta?: Record<string, unknown>): void {
  // Route through the shared structured logger: one redacted JSON line per call,
  // the `meta` carried as the structured detail payload. The dispatcher's invariant
  // ("notifications never block workflow progress") is unchanged — logging never throws.
  dispatcherLogger[level](message, {}, meta);
}
