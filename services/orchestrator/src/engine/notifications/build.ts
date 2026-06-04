// Production construction of the NotificationDispatcher: the single place the
// worker boot builds the channel registry (with the REAL channel deps) and the
// dispatcher (with the code-level default route). Constructed ONCE per process
// and shared across every dispatched event — never per-event.
//
// Channel deps: every credential-resolving channel is handed the worker's
// `secrets` store so Slack / webhook / teams / discord / twilio / pagerduty /
// email resolve their write-only credential refs, and github_checks reuses the
// shared App-token minter. ntfy needs nothing (its base URL is env-defaulted).
// Supplying `secrets` keeps each kind WIRED (a real adapter), so a configured
// route actually delivers rather than recording a `stubbed` audit row.
//
// Default route: resolved from the environment as the code-level fallback so a
// fail-severity escalation (`dag.spec.needs_attention`) reaches a human even on
// an org that never configured a `notification_routes` row. Per-org routes
// always override it (the dispatcher only consults the default when the matrix
// matched nothing). When NO default is configured, a fail-severity event with
// no route emits a LOUD log inside the dispatcher (never a silent drop).

import type pg from "pg";
import { orgScopingPool } from "../data/orgScopedDb.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import { NotificationDispatcher, type DefaultRoute } from "./dispatcher.js";
import { buildChannelRegistry } from "./registry.js";
import { ChannelKind } from "./schemas.js";

export interface BuildNotificationDispatcherDeps {
  /**
   * The worker pool. The dispatcher loads the org matrix + writes the dispatch
   * ledger through it, WRAPPED in `orgScopingPool` so each `notification_targets`
   * / `notification_routes` read and each `notifications` write self-routes under
   * the ambient per-event org scope (the subscriber sets it via `runWithJobOrgId`
   * before calling `onEvent`). Under enforced RLS an unscoped tenant read would
   * see zero rows; the org-scoping wrapper makes the matrix read see exactly the
   * event's org.
   */
  pool: pg.Pool;
  /** The worker's secret store — every credential-resolving channel resolves its write-only ref through it. */
  secrets: SecretStore;
  /** The shared App-token minter github_checks reuses (its cache lives in the worker boot). */
  githubAppMinter?: GithubAppTokenMinter;
}

/**
 * Build the production dispatcher. LOUD failure (not a silent skip) if the
 * required `secrets` dep is missing — a credential-resolving channel with no
 * store could only ever stub, which would silently swallow real escalations.
 */
export function buildNotificationDispatcher(deps: BuildNotificationDispatcherDeps): NotificationDispatcher {
  if (deps.secrets === undefined) {
    throw new Error(
      "buildNotificationDispatcher requires a secret store (channels resolve write-only credential refs)",
    );
  }
  const channels = buildChannelRegistry({
    ntfy: {},
    slack: { secrets: deps.secrets },
    webhook: { secrets: deps.secrets },
    teams: { secrets: deps.secrets },
    discord: { secrets: deps.secrets },
    twilio: { secrets: deps.secrets },
    pagerduty: { secrets: deps.secrets },
    email: { secrets: deps.secrets },
    github: {
      secrets: deps.secrets,
      ...(deps.githubAppMinter !== undefined && { minter: deps.githubAppMinter }),
    },
  });
  const defaultRoute = resolveDefaultRouteFromEnv();
  return new NotificationDispatcher({
    // org-scoping wrapper: each tenant-table read/write self-routes under the
    // per-event org scope the subscriber establishes via `runWithJobOrgId`.
    query: orgScopingPool(deps.pool),
    channels,
    ...(defaultRoute !== undefined && { defaultRoute }),
  });
}

/**
 * Resolve the code-level default route from the environment. Both the channel
 * kind and a destination are required for the default to be active; either one
 * missing ⇒ no default (the dispatcher then LOUD-logs a fail-severity event
 * that matched no per-org route). An unknown channel kind is a LOUD throw — a
 * typo here must never silently disable the escalation safety net.
 */
function resolveDefaultRouteFromEnv(): DefaultRoute | undefined {
  const kind = process.env["TANREN_NOTIFICATION_DEFAULT_CHANNEL"];
  const destination = process.env["TANREN_NOTIFICATION_DEFAULT_DESTINATION"];
  if (kind === undefined || kind === "" || destination === undefined || destination === "") {
    return undefined;
  }
  const parsed = ChannelKind.safeParse(kind);
  if (!parsed.success) {
    throw new Error(
      `TANREN_NOTIFICATION_DEFAULT_CHANNEL=${JSON.stringify(kind)} is not a known channel kind (${ChannelKind.options.join(", ")})`,
    );
  }
  const minSeverityEnv = process.env["TANREN_NOTIFICATION_DEFAULT_MIN_SEVERITY"];
  return {
    channelKind: parsed.data,
    destination,
    // Defaults to `warn` inside the dispatcher when omitted; only an explicit
    // valid value overrides it (an invalid value is ignored, keeping the safe
    // warn floor).
    ...(minSeverityEnv === "ok" || minSeverityEnv === "info" || minSeverityEnv === "warn" || minSeverityEnv === "fail"
      ? { minSeverity: minSeverityEnv }
      : {}),
  };
}
