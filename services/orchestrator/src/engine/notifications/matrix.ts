import { type NotificationRouteRow, type NotificationTargetRow, type Severity, severityMeetsFloor } from "./schemas.js";

// matrix evaluation.
//
// The matrix is `notification_targets × notification_routes` plus the
// hi-fi's two-layer model: a `scope = user` target row overrides a
// `scope = org` target row for the same `(orgId, channelKind)` *only when
// the user-scope target also has a route enabled for the same eventName*.
// In other words: user rows do not silently disable org rows; they
// supersede them on a per-event basis.
//
// `evaluateMatrix` returns the targets that should actually fire for the
// given event. The dispatcher walks the result, applies redaction, and
// hands each pair to the appropriate channel.

export interface MatrixContext {
  // Targets in this org (both org-scoped and user-scoped). The dispatcher
  // pre-fetches and passes them in to avoid a per-event query.
  targets: ReadonlyArray<NotificationTargetRow>;
  // Routes keyed against any of those targets. The dispatcher pre-fetches
  // routes for the specific `eventName` to keep the working set small.
  routes: ReadonlyArray<NotificationRouteRow>;
  // The actor whose user-scoped overrides should layer on top of org
  // defaults. `null` means "no overrides" — typical for system-emitted
  // events (run.failed dispatched by the engine, not by a specific user).
  actorUserId: string | null;
}

export interface MatrixEvaluationInput extends MatrixContext {
  eventName: string;
  effectiveSeverity: Severity;
}

export interface MatrixMatch {
  target: NotificationTargetRow;
  route: NotificationRouteRow;
  // The reason this route was kept after layering. Useful for the
  // dispatcher's audit log and for the matrix UI's "why did this fire?"
  // hover affordance.
  layering: "org_default" | "user_override";
}

// evaluateMatrix returns the ordered list of (target, route) pairs that
// the dispatcher should publish. Order: user-scoped overrides first
// (because they are explicit operator preference), then org defaults.
export function evaluateMatrix(input: MatrixEvaluationInput): MatrixMatch[] {
  const routesByTarget = indexRoutesByTarget(input.routes, input.eventName);
  const matches: MatrixMatch[] = [];

  // Index user-scope target ids by (channelKind) for override lookups.
  // The hi-fi's layering is per-channel: a user can opt out of a slack
  // route while keeping the org's ntfy route active.
  const userOverrideChannels = new Set<string>();
  for (const target of input.targets) {
    if (target.scope === "user" && target.userId === input.actorUserId) {
      const route = routesByTarget.get(target.id);
      if (route !== undefined && isLive(target, route, input.effectiveSeverity)) {
        matches.push({ target, route, layering: "user_override" });
      }
      // Always mark the channelKind as user-customized so the org default
      // does not fire alongside the user row, even if the user route was
      // muted/disabled — the user has explicitly taken control of this
      // (orgId, channelKind) pair for this event.
      userOverrideChannels.add(`${target.channelKind}`);
    }
  }

  for (const target of input.targets) {
    if (target.scope !== "org") continue;
    if (userOverrideChannels.has(target.channelKind)) continue;
    const route = routesByTarget.get(target.id);
    if (route === undefined) continue;
    if (!isLive(target, route, input.effectiveSeverity)) continue;
    matches.push({ target, route, layering: "org_default" });
  }

  return matches;
}

function indexRoutesByTarget(
  routes: ReadonlyArray<NotificationRouteRow>,
  eventName: string,
): Map<string, NotificationRouteRow> {
  const map = new Map<string, NotificationRouteRow>();
  for (const route of routes) {
    if (route.eventName !== eventName) continue;
    map.set(route.targetId, route);
  }
  return map;
}

function isLive(target: NotificationTargetRow, route: NotificationRouteRow, effectiveSeverity: Severity): boolean {
  if (!target.enabled) return false;
  if (!route.enabled) return false;
  if (!severityMeetsFloor(effectiveSeverity, route.minSeverity)) return false;
  return true;
}

// isWeekendInUtc returns true when `now` falls on Saturday or Sunday in
// UTC. v0 uses UTC by design; an org timezone is a later option (the
// matrix already carries `weekendMute` as a per-target flag so no schema
// change is needed there).
export function isWeekendInUtc(now: Date): boolean {
  const dayUtc = now.getUTCDay();
  return dayUtc === 0 || dayUtc === 6;
}
