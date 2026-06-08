// P1d autonomous intake — the polling (pull) fallback (autonomy-engine.md §1d:
// "Polling (pull) fallback for sources/configs without a webhook — a scheduled
// poller on a per-source interval"). This generalizes `forge/audits/scheduler.ts`
// (a single pass) into a recurring per-source loop: every source whose config
// opts into polling (and is NOT webhook-driven) is ingested on its own interval,
// honoring rate limits + budget (one source ingested per due tick), each pull
// flowing through the SAME triage → auto-route/inbox engine the webhook uses.
//
// A source is webhook-driven when its `config.webhookSecretRef` is set — for that
// source push is authoritative and the poller skips it (push-preferred, §1d). A
// source is pollable when it has a connector kind and is enabled.

import type pg from "pg";
import { runWithJobOrgId, runWithSystemScope } from "@tanren/db";
import { z } from "zod";
import { orgScopingPool } from "../../data/orgScopedDb.js";
import type { SecretStore } from "../../contracts/secretStore.js";
import type { GitHubHttpClient } from "../../providers/github.js";
import type { GithubAppTokenMinter } from "../../providers/githubAppTokenMinter.js";
import {
  ingestSource,
  InboxStore,
  type AutoRouteDeps,
  type Candidate,
  type InboxEngineDeps,
  type InboxSource,
  type SourceConnector,
  type TriageAnswerer,
} from "../inbox/index.js";
import { buildIntakeConnectorMapForOrg, isCredentialResolutionError } from "./issueSourceSeam.js";

// The poll knobs a source carries on its `config` (alongside the connector's own
// config). `pollIntervalMs` is the per-source cadence; absence ⇒ the org default.
// `webhookSecretRef` (when set) marks the source webhook-driven — the poller
// skips it (push is authoritative). Parsed leniently so connector config coexists.
const PollConfig = z
  .object({
    pollIntervalMs: z.number().int().positive().optional(),
    webhookSecretRef: z.string().min(1).optional(),
  })
  .passthrough();

/** The default per-source poll interval when the source pins none (5 minutes). */
export const DEFAULT_POLL_INTERVAL_MS = 5 * 60_000;

export interface IntakePollerDeps {
  pool: pg.Pool;
  // The transports the poller rebuilds a PER-ORG connector map from on each poll.
  // The GitHub credential is resolved per-org via the IssueSource seam — App
  // installation token when installed, ELSE the org's default static token — so the
  // poller cannot share one org-agnostic connector map; it builds the map per
  // source-org with that org's resolved credential threaded in (see
  // `pollSourceOnce`). `secrets`/`githubHttp`/`minter` are those transports;
  // `connectors` (when given) is a test override of the whole built map.
  secrets: SecretStore;
  githubHttp: GitHubHttpClient;
  // The shared App-token minter (installation-token cache). Optional: used for the
  // App-installation path; an org on the static-token path needs none, and its
  // absence does NOT silently disable intake (a configured GitHub source with no
  // resolvable credential is a LOUD fail-closed error — see the IssueSource seam).
  githubAppMinter?: GithubAppTokenMinter;
  // Test seam: a fixed connector map, used VERBATIM for every org (bypasses the
  // per-org credential resolution + rebuild). Production omits this and the poller
  // builds per-org.
  connectors?: ReadonlyMap<string, SourceConnector>;
  // Resolve a per-source triage answerer (the source's project `forge` routing).
  // REQUIRED — the poll path triages with a real model (no §8a fallback).
  answererFactory: (target: { orgId: string; projectId?: string }) => TriageAnswerer;
  // The autonomous DAG-insert deps (system actor) — an auto-routable poll result
  // is committed into the DAG, exactly like the webhook path.
  autoRoute: AutoRouteDeps;
  // Clock seam (tests drive due-ness deterministically).
  now?: () => number;
}

// The connector kinds the poller can serve. `isPollableSource` probes this WITHOUT
// resolving any org (the per-org App rebuild happens later, per due source), so an
// App-only org's GitHub source is still recognized as pollable.
const POLLABLE_KINDS: ReadonlySet<string> = new Set(["issues", "errors"]);

/**
 * Whether a source is eligible for polling at all (webhook-driven sources are
 * skipped). The supported kinds are probed against `connectors` when a fixed map is
 * supplied (the test override), else against the built-in `POLLABLE_KINDS` set — so
 * an App-only org's `issues` source (whose per-org connector is built later) is
 * still recognized as pollable.
 */
export function isPollableSource(source: InboxSource, connectors?: ReadonlyMap<string, SourceConnector>): boolean {
  if (!source.enabled) return false;
  const known = connectors === undefined ? POLLABLE_KINDS.has(source.kind) : connectors.has(source.kind);
  if (!known) return false;
  const config = PollConfig.safeParse(source.config);
  // A webhook-driven source (a configured secret) is served by push — skip it.
  if (config.success && config.data.webhookSecretRef !== undefined) return false;
  return true;
}

function pollIntervalFor(source: InboxSource): number {
  const config = PollConfig.safeParse(source.config);
  return config.success && config.data.pollIntervalMs !== undefined
    ? config.data.pollIntervalMs
    : DEFAULT_POLL_INTERVAL_MS;
}

export interface PollSourceResult {
  source: InboxSource;
  candidates: Candidate[];
}

/**
 * Poll one source once: pull → triage → auto-route/inbox, through the SAME
 * `ingestSource` engine the manual route uses, with the autonomous auto-route
 * wired so an `auto_routable` item is inserted into the DAG. Resolves the
 * source-scoped triage answerer first.
 */
export async function pollSourceOnce(deps: IntakePollerDeps, source: InboxSource): Promise<PollSourceResult> {
  // `ingestSource` does tenant reads/writes (existing-spec read, candidate upsert,
  // and — on auto-route — the discovery accept + DAG insert) directly on its pool.
  // The poller wakes cross-org with NO ambient scope, so on the bare pool those run
  // with an empty `app.current_org_id` GUC and RLS denies them under `tanren_app`.
  // The source carries a concrete `orgId` (always set), so ingest under the source's
  // per-job org id AND hand the engine the org-scoping proxy: each direct `.query`
  // opens a short `runWithOrgScope` carrying the source's org GUC.
  //
  // Intake credential resolution (no-silent-fallbacks fix): build the connector map
  // for THIS source's ORG via the IssueSource seam, which resolves the GitHub
  // credential EXPLICITLY — App installation token when installed, ELSE the org's
  // default static token — exactly how the rest of the engine resolves it. When
  // this source is a configured GitHub issues source but NO credential resolves,
  // the seam raises a LOUD `IntakeGithubCredentialMissingError` (fail-closed),
  // never a silent no-connector. A test may pin a fixed `connectors` map (used
  // verbatim); production omits it and we rebuild per-org.
  const connectors = deps.connectors ?? (await buildOrgConnectorMap(deps, source));
  const engineDeps: InboxEngineDeps = {
    pool: orgScopingPool(deps.pool),
    connectors,
    answerer: deps.answererFactory({
      orgId: source.orgId,
      ...(source.projectId === null ? {} : { projectId: source.projectId }),
    }),
  };
  const { candidates } = await runWithJobOrgId(source.orgId, () => ingestSource(engineDeps, source, deps.autoRoute));
  return { source, candidates };
}

/**
 * Build the inbox connector map for one source's org via the IssueSource seam.
 * The seam resolves the GitHub credential EXPLICITLY (App installation when
 * installed, else the org-default static token) and raises a LOUD fail-closed
 * error when `source` is a configured GitHub issues source but no credential
 * resolves — distinct from the legitimate "no GitHub intake configured" case.
 */
async function buildOrgConnectorMap(
  deps: IntakePollerDeps,
  source: InboxSource,
): Promise<ReadonlyMap<string, SourceConnector>> {
  return buildIntakeConnectorMapForOrg(
    {
      pool: deps.pool,
      secrets: deps.secrets,
      githubHttp: deps.githubHttp,
      ...(deps.githubAppMinter === undefined ? {} : { githubAppMinter: deps.githubAppMinter }),
    },
    source.orgId,
    [source],
  );
}

/**
 * The recurring poller. `start()` runs a tick on an interval; each tick lists
 * every org's pollable sources (system-scoped — the poller is cross-org like the
 * worker bootstrap) and ingests those whose per-source interval has elapsed since
 * their last poll. Per-source last-poll timing is in-memory (the loop is a
 * single long-lived process); a missed tick simply ingests on the next one.
 */
export class IntakePoller {
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private ticking = false;
  private readonly lastPolledAt = new Map<string, number>();
  private readonly now: () => number;

  constructor(
    private readonly deps: IntakePollerDeps,
    private readonly tickIntervalMs: number = 60_000,
  ) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** Begin ticking. The first tick runs immediately (off the event loop). */
  start(): void {
    if (this.timer !== undefined) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.tickIntervalMs);
    // Do not keep the process alive solely for the poll loop.
    this.timer.unref?.();
  }

  /** Stop ticking. Idempotent; an in-flight tick finishes on its own. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Run one poll pass over all due, pollable sources. Returns what it polled (tests assert). */
  async tick(): Promise<PollSourceResult[]> {
    if (this.ticking || this.stopped) return [];
    this.ticking = true;
    try {
      // A failure to LIST sources (e.g. the DB not yet reachable at boot) is
      // logged, never thrown — the next tick retries (mirrors the DagWalker's
      // tolerance of a not-yet-ready pool).
      let sources: InboxSource[];
      try {
        sources = await this.listDuePollableSources();
      } catch (error) {
        console.error("[intake-poller] failed to list pollable sources (will retry next tick):", error);
        return [];
      }
      const results: PollSourceResult[] = [];
      for (const source of sources) {
        try {
          results.push(await pollSourceOnce(this.deps, source));
          this.lastPolledAt.set(source.id, this.now());
        } catch (error) {
          // A credential-RESOLUTION failure is a MISCONFIGURATION, not a transient:
          // per the no-silent-fallbacks doctrine it is a LOUD fail-closed error that
          // must NOT be swallowed-and-retried (which would quietly degrade to "this
          // source never ingests"). This covers BOTH paths uniformly via the shared
          // predicate — the eager org-default resolution (IntakeGithubCredentialMissingError)
          // AND the lazy source-owned `config.staticRef` resolution inside the
          // connector's fetch (No/MissingGithubCredentialRefError). Re-throw so the
          // failure surfaces loudly at the tick boundary, naming the credential.
          if (isCredentialResolutionError(error)) throw error;
          // Any OTHER source failure (rate limit, transient connector error) never
          // stalls the others; it retries on the next due tick.
          console.error(`[intake-poller] poll of source ${source.id} failed:`, error);
          this.lastPolledAt.set(source.id, this.now());
        }
      }
      return results;
    } finally {
      this.ticking = false;
    }
  }

  /** List every org's pollable, due-now source (cross-org, system-scoped). */
  private async listDuePollableSources(): Promise<InboxSource[]> {
    const orgIds = await runWithSystemScope(this.deps.pool, (client) =>
      InboxStore.listDistinctEnabledSourceOrgIds(client),
    );
    const due: InboxSource[] = [];
    const now = this.now();
    for (const orgId of orgIds) {
      const sources = await runWithSystemScope(this.deps.pool, (client) => InboxStore.listSources(client, orgId));
      for (const source of sources) {
        if (!isPollableSource(source, this.deps.connectors)) continue;
        const last = this.lastPolledAt.get(source.id);
        if (last !== undefined && now - last < pollIntervalFor(source)) continue;
        due.push(source);
      }
    }
    return due;
  }
}
