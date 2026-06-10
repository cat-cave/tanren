import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import type { EventName, TypedEvent } from "../events/index.js";
import { redactEventPayload } from "../redaction/index.js";
import type { NotificationChannel } from "./channels/types.js";
import { defaultSeverityFor } from "./eventDefaultSeverity.js";
import { evaluateMatrix, isWeekendInUtc, type MatrixContext } from "./matrix.js";
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
//   1. Resolve the event's effective severity (default-map + verdict
//      promotion: a checker/auditor.verdict with passed=false promotes
//      one tier so the matrix's `warn` floor catches it).
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
  // guarantee). When an event's effective severity meets `minSeverity`
  // (default `warn`) and NO per-org `notification_routes` row matched it, the
  // dispatcher delivers to this fallback channel/destination so a genuine
  // escalation — most importantly `dag.spec.needs_attention` — still reaches a
  // human even on an org that never configured a route. Per-org routes that DO
  // match always take precedence (and augment, not replace) the default — the
  // default fires ONLY when the matrix found nothing. When this is absent and a
  // fail-severity event matched no route, the dispatcher emits a LOUD log
  // (never a silent drop) so the gap is visible.
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

export interface EventContext {
  // The org under which this event was emitted. The dispatcher will not
  // load matrix rows without it; events scoped to a null org (system
  // events) are skipped.
  orgId: string | null;
  // The acting user, if any. User-scope target rows override org-scope
  // rows for this user. System events leave this null.
  actorUserId: string | null;
  // Optional run/spec/project identifiers; used to enrich the payload
  // body and to compute the deep link.
  runId?: string | null;
  specId?: string | null;
  projectId?: string | null;
}

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
   * No configured route matched this event. The "never silently drop a genuine
   * escalation" guarantee: if the event's effective severity meets the default
   * route's floor (default `warn`) we deliver to the code-level default channel
   * when one is configured; otherwise — a fail-severity event with no route at
   * all — we emit a LOUD log (never a silent drop). A routine sub-floor event
   * (info/ok lifecycle) returns quietly: that is the no-spam contract, not a
   * dropped escalation.
   */
  private async handleNoMatch(event: TypedEvent, context: EventContext, severity: Severity): Promise<void> {
    const floor = this.defaultRoute?.minSeverity ?? "warn";
    if (!severityMeetsFloor(severity, floor)) return;

    if (this.defaultRoute === undefined) {
      // A genuine escalation that reaches NO human because the org configured no
      // route AND no code-level default is wired. This is the loud failure the
      // no-silent-fallback rule demands — surfaced, never swallowed.
      this.log("error", "no notification route configured for a fail-severity event", {
        eventName: event.eventType,
        severity,
        orgId: context.orgId,
        specId: context.specId ?? null,
        runId: context.runId ?? null,
      });
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
      eventName: event.eventType as EventName,
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

// effectiveSeverityFor: the registry's default-severity map is the base
// rate; a few payload shapes carry per-instance severity hints we honor:
//   - checker.verdict / auditor.verdict: passed=false promotes one tier.
//   - run.completed with outcome containing "fail" promotes to warn.
// This keeps the matrix actionable without proliferating event names.
export function effectiveSeverityFor(event: TypedEvent): Severity {
  const base = defaultSeverityFor(event.eventType as EventName);
  if (event.eventType === "checker.verdict" || event.eventType === "auditor.verdict") {
    const payload = event.payload as { passed?: boolean };
    if (payload.passed === false) {
      return promote(base);
    }
    return "ok";
  }
  if (event.eventType === "run.completed") {
    const payload = event.payload as { outcome?: string };
    if (typeof payload.outcome === "string" && payload.outcome.includes("fail")) {
      return promote(base);
    }
  }
  // Security-baseline cleanup-proof: a clean release is info; a FAILED teardown
  // (`cleanedUp=false`, residual resources to reconcile) promotes one tier so a
  // leaked runner reaches the operator.
  if (event.eventType === "release.finalized") {
    const payload = event.payload as { cleanedUp?: boolean };
    if (payload.cleanedUp === false) {
      return promote(base);
    }
  }
  return base;
}

function promote(severity: Severity): Severity {
  switch (severity) {
    case "ok":
      return "info";
    case "info":
      return "warn";
    case "warn":
      return "fail";
    case "fail":
      return "fail";
  }
}

function titleFor(eventName: string, severity: Severity): string {
  return `[${severity.toUpperCase()}] ${eventName}`;
}

function bodyFor(eventName: string, context: EventContext, redactedPayload: unknown): string {
  const lines: string[] = [];
  if (context.projectId) lines.push(`project=${context.projectId}`);
  if (context.runId) lines.push(`run=${context.runId}`);
  if (context.specId) lines.push(`spec=${context.specId}`);
  lines.push(`event=${eventName}`);
  // Stringify the redacted payload defensively; markers serialize cleanly.
  let serialized = "";
  try {
    serialized = JSON.stringify(redactedPayload);
  } catch {
    serialized = "<unserializable>";
  }
  // Cap the body so a verbose payload doesn't blow up ntfy / future
  // channels. 4096 is generous; ntfy limits are stricter in practice and
  // its server truncates further if needed.
  if (serialized.length > 4096) {
    serialized = `${serialized.slice(0, 4093)}...`;
  }
  lines.push(serialized);
  return lines.join("\n");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

const dispatcherLogger = createLogger("notifications");

function defaultLog(level: "info" | "warn" | "error", message: string, meta?: Record<string, unknown>): void {
  // Route through the shared structured logger: one redacted JSON line per call,
  // the `meta` carried as the structured detail payload. The dispatcher's invariant
  // ("notifications never block workflow progress") is unchanged — logging never throws.
  dispatcherLogger[level](message, {}, meta);
}
