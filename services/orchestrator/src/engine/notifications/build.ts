// Production construction of the NotificationDispatcher: the single place the
// worker boot builds the channel registry (with the REAL channel deps) and the
// dispatcher (with the code-level default route). Constructed ONCE per process
// and shared across every dispatched event — never per-event.
//
// Channel deps: every credential-resolving channel is handed the worker's
// `secrets` store so Slack / webhook / teams / discord / twilio / pagerduty /
// email resolve their write-only credential refs, and github_checks reuses the
// shared App-token minter. ntfy is handed the DEPLOY-default base URL read HERE
// (the boot wiring), never inside the channel — a per-org target's own
// `base_url` is authoritative and the deploy default applies only when a
// target leaves it unset (audit C4 / RC-1). Supplying `secrets` keeps each
// kind WIRED (a real adapter), so a configured route actually delivers rather
// than recording a `stubbed` audit row.
//
// Default route: resolved from the environment as the code-level fallback so a
// fail-severity escalation (`dag.spec.needs_attention`) reaches a human even on
// an org that never configured a `notification_routes` row. Per-org routes
// always override it (the dispatcher only consults the default when the matrix
// matched nothing). When NO default is configured, a fail-severity event with
// no route emits a LOUD log inside the dispatcher (never a silent drop).

import type pg from "pg";
import { orgScopingPool } from "../data/orgScopedDb.js";
import { isApexMode } from "../config/apexMode.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import { NotificationDispatcher, type DefaultRoute } from "./dispatcher.js";
import type { NtfyChannelDeps } from "./channels/ntfy.js";
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
    ntfy: resolveNtfyDeployDefault(),
    slack: { secrets: deps.secrets },
    webhook: { secrets: deps.secrets },
    teams: { secrets: deps.secrets },
    discord: { secrets: deps.secrets },
    twilio: { secrets: deps.secrets },
    pagerduty: { secrets: deps.secrets },
    email: { secrets: deps.secrets },
    github: {
      secrets: deps.secrets,
      // The pool: github_checks resolves the PUBLISHING org's OWN github credential
      // from the ambient per-event org scope at publish time (loadOrg* query by the
      // explicit getJobOrgId), never a shared/deploy token — no cross-tenant leak.
      pool: deps.pool,
      ...(deps.githubAppMinter !== undefined && { minter: deps.githubAppMinter }),
    },
  });
  const defaultRoute = resolveDefaultRouteFromEnv();
  // Apex-mode readiness (no-silent doctrine): on a live apex run a `warn`+ event
  // that matched NO per-org route AND has NO code-level default would silently
  // log-and-return — no human ever sees a budget/deploy milestone. That gap must
  // be LOUD, not discovered post-run. In apex mode the env default is the
  // process-wide safety net under EVERY org (the onboarding seed handles the
  // per-tenant route); its absence is a startup readiness FAILURE, not a warning
  // buried in logs. Outside apex mode the env default stays optional (per-org
  // routes + the seeded default carry delivery).
  if (isApexMode() && defaultRoute === undefined) {
    throw new Error(
      "apex mode requires a code-level default notification route: set TANREN_NOTIFICATION_DEFAULT_CHANNEL + " +
        "TANREN_NOTIFICATION_DEFAULT_DESTINATION so a warn+ milestone (budget / deploy.verified / needs_attention) " +
        "with no per-org route still reaches a human (no silent log-and-return)",
    );
  }
  return new NotificationDispatcher({
    // org-scoping wrapper: each tenant-table read/write self-routes under the
    // per-event org scope the subscriber establishes via `runWithJobOrgId`.
    query: orgScopingPool(deps.pool),
    channels,
    ...(defaultRoute !== undefined && { defaultRoute }),
  });
}

/**
 * Resolve the ntfy DEPLOY-default base URL from the environment — read HERE in
 * the boot wiring (never inside the channel, per audit C4 / RC-1) and injected
 * via `deps.baseUrl`. This default applies ONLY to a bare-topic target that
 * left its own `base_url` unset; a per-org `base_url` is always authoritative.
 * Compose dev ships ntfy on port 80 inside the stack, so that is the hard
 * floor when the env is unset. An empty env value falls back to the floor too.
 */
function resolveNtfyDeployDefault(): NtfyChannelDeps {
  const deployBaseUrl = process.env["TANREN_NTFY_BASE_URL"];
  return {
    baseUrl: deployBaseUrl !== undefined && deployBaseUrl !== "" ? deployBaseUrl : "http://ntfy:80",
  };
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
