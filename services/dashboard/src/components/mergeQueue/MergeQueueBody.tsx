/**
 * Merge-queue operator panel body. Renders two aggregate views of the native
 * delivery engine, both REPORTED (not targeted), derived orchestrator-side from
 * the engine's own events:
 *   1. rebase vs rebuild — the never-discard base-shift read-side
 *      (`GET .../integration-metrics`): did keeping work alive by rebasing cost
 *      less than re-planning it?
 *   2. native merge queue — depth, time-in-queue, batch pass-rate, bisect, and
 *      dequeue breakdown (`GET .../queue-stats`).
 *
 * Presentation only — every figure comes from the orchestrator payloads;
 * uncomputable figures render "—", never a fake zero.
 */

import type { IntegrationMetrics, QueueStats } from "../../api/mergeQueue.js";
import type { MergeQueueAuthorityEvaluationsListResponse } from "../../api/mergeQueueAuthorityEvaluations.js";
import type { MergeQueueAuthoritySignalsListResponse } from "../../api/mergeQueueAuthoritySignals.js";
import { AuthoritySignalPanel } from "./AuthoritySignalPanel.js";
import { mqDuration, mqInt, mqPercent, mqTokens } from "./format.js";
import { MultiMemberAuthorityPanel } from "./MultiMemberAuthorityPanel.js";
import { RepairRouteLineagePanel } from "./RepairRouteLineagePanel.js";
import { MergeTrainPanel } from "./MergeTrainPanel.js";
import type { MergeQueueRepairRoutesListResponse } from "../../api/mergeQueueRepairRoutes.js";
import type { MergeTrainListResponse } from "../../api/mergeQueueTrain.js";
import { MERGE_QUEUE_SCREEN_CSS } from "./styles.js";

export interface MergeQueueBodyProps {
  /** Rebase/rebuild metrics, or `undefined` when the read failed / no project. */
  metrics: IntegrationMetrics | undefined;
  /** Native queue stats, or `undefined` when the read failed / no project. */
  stats: QueueStats | undefined;
  /** mq-1 authority-signal projection (undefined when read failed / no project). */
  authoritySignals: MergeQueueAuthoritySignalsListResponse | undefined;
  /** mq-2 durable exact-node authority projection (undefined when read failed / no project). */
  authorityEvaluations: MergeQueueAuthorityEvaluationsListResponse | undefined;
  /** mq-10 durable autonomous-repair + respec lineage (undefined when read failed / no project). */
  repairRoutes: MergeQueueRepairRoutesListResponse | undefined;
  /** mq-15 durable sealed merge-train projection (undefined when read failed / no project). */
  mergeTrain: MergeTrainListResponse | undefined;
  /** Org id for the mq-15 artifact links. */
  orgId: string;
  /** Project id for the mq-15 artifact links. */
  projectId: string;
  /** Active window pill (7d / 30d / 90d). */
  windowDays: number;
  /** Project name for the eyebrow scope line. */
  projectName: string;
  /** Whether the operator has a visible project at all. */
  noProject: boolean;
}

const WINDOWS: number[] = [7, 30, 90];

interface StatCard {
  label: string;
  value: string;
  sub: string;
  sample?: number;
}

/** True when a formatted value is the "—" no-data sentinel. */
function isEmpty(value: string): boolean {
  return value === "—";
}

/** Rebase-vs-rebuild cards from the integration-metrics payload. */
function rebaseCards(m: IntegrationMetrics | undefined): StatCard[] {
  const rvr = m?.rebaseVsRebuild;
  return [
    {
      label: "kept-alive cost",
      value: mqTokens(rvr?.keptAliveMedianTokens ?? null),
      sub: "median tokens · clean + resolved rebases",
      sample: rvr?.keptAliveSample ?? 0,
    },
    {
      label: "rebuild cost",
      value: mqTokens(rvr?.replannedMedianTokens ?? null),
      sub: "median tokens · replanned work",
      sample: rvr?.replannedSample ?? 0,
    },
    {
      label: "clean rebases",
      value: mqInt(m?.buckets.rebased_clean.count ?? null),
      sub: "no conflicts",
    },
    {
      label: "resolved rebases",
      value: mqInt(m?.buckets.rebased_resolved.count ?? null),
      sub: "conflicts auto-resolved",
    },
    {
      label: "replanned",
      value: mqInt(m?.buckets.replanned.count ?? null),
      sub: "had to rebuild",
    },
    {
      label: "proof reuse",
      value: mqInt(m?.proofReuseCount ?? null),
      sub: "checks reused, not re-run",
    },
  ];
}

/** Native-queue cards from the queue-stats payload. */
function queueCards(s: QueueStats | undefined): StatCard[] {
  return [
    {
      label: "max depth",
      value: mqInt(s?.maxDepth ?? null),
      sub: "peak ready entries in queue",
    },
    {
      label: "mean depth",
      value: s?.meanDepth === undefined || s.meanDepth === null ? "—" : s.meanDepth.toFixed(1),
      sub: "average queue depth",
    },
    {
      label: "time in queue",
      value: mqDuration(s?.medianTimeInQueueSeconds ?? null),
      sub: "median queued → left the queue",
      sample: s?.timeInQueueSample ?? 0,
    },
    {
      label: "batch pass rate",
      value: mqPercent(s?.batchPassRate ?? null),
      sub: `${s?.batchesPassed ?? 0}/${s?.batchesChecked ?? 0} speculative batches passed`,
    },
    {
      label: "bisected",
      value: mqInt(s?.batchesBisected ?? null),
      sub: `${s?.culpritsIsolated ?? 0} culprit(s) isolated`,
    },
    {
      label: "max stack depth",
      value: mqInt(s?.maxStackDepth ?? null),
      sub: "deepest dependency chain",
    },
  ];
}

/** The rebase < rebuild verdict line. */
function verdict(m: IntegrationMetrics | undefined): { text: string; cheaper: boolean } {
  const cheaper = m?.rebaseVsRebuild.rebaseCheaper ?? null;
  if (cheaper === true) return { text: "✓ rebase < rebuild — the never-discard rebase paid off", cheaper: true };
  if (cheaper === false) return { text: "rebuild was cheaper this window", cheaper: false };
  return { text: "not enough samples to compare rebase vs rebuild yet", cheaper: false };
}

function StatGrid(props: { cards: StatCard[] }) {
  return (
    <div class="mq-grid">
      {props.cards.map((card) => (
        <div class="mq-card">
          <span class="label">{card.label}</span>
          <span class={`value${isEmpty(card.value) ? " empty" : ""}`}>{card.value}</span>
          <span class="sub">{card.sub}</span>
          {card.sample === undefined ? null : <span class="sample">n={card.sample}</span>}
        </div>
      ))}
    </div>
  );
}

export function MergeQueueBody(props: MergeQueueBodyProps) {
  const {
    metrics,
    stats,
    authoritySignals,
    authorityEvaluations,
    repairRoutes,
    mergeTrain,
    orgId,
    projectId,
    windowDays,
    projectName,
    noProject,
  } = props;
  const v = verdict(metrics);
  return (
    <>
      <style data-screen="merge-queue" dangerouslySetInnerHTML={{ __html: MERGE_QUEUE_SCREEN_CSS }} />
      <div class="page-head">
        <div>
          <div class="eyebrow">▮ project · merge queue · native delivery · {projectName || "no project"}</div>
          <div class="page-title">how work merges</div>
        </div>
        <div class="filters">
          {WINDOWS.map((w) => (
            <a class={`pill${w === windowDays ? " hot" : ""}`} href={`/merge-queue?windowDays=${w}`}>
              {w}d
            </a>
          ))}
        </div>
      </div>
      <div class="page-body">
        <div class="merge-queue-screen">
          {noProject ? (
            <section class="panel">
              <div class="empty">
                No project visible yet. Onboard one to start forging — once base-shifts and merges land, the
                rebase-vs-rebuild economics and native queue statistics compute here from the engine's own event
                history.
              </div>
            </section>
          ) : (
            <>
              <MergeTrainPanel projection={mergeTrain} orgId={orgId} projectId={projectId} />
              <MultiMemberAuthorityPanel projection={authorityEvaluations} />
              <RepairRouteLineagePanel projection={repairRoutes} />
              <AuthoritySignalPanel projection={authoritySignals} />
              <section class="panel">
                <div class="panel-pad">
                  <div class="mini-eyebrow">
                    rebase vs rebuild · {windowDays}d window{" "}
                    <span class="window-tag">(never-discard read-side · reported)</span>
                  </div>
                  {metrics === undefined ? (
                    <div class="empty">
                      Rebase metrics unavailable — the orchestrator read failed, or no base-shifts have been recorded in
                      this window yet.
                    </div>
                  ) : (
                    <>
                      <div class={`verdict ${v.cheaper ? "cheaper" : "neutral"}`}>{v.text}</div>
                      <StatGrid cards={rebaseCards(metrics)} />
                      <div class="note">
                        <b>↑ never-discard.</b> When an ancestor merges, dependent work is <b>rebased in place</b>, not
                        discarded and regenerated. "kept-alive cost" is the median token cost of that rebased work vs.
                        "rebuild cost" for work that had to be re-planned; when kept-alive is lower, the rebase paid
                        off.
                      </div>
                    </>
                  )}
                </div>
              </section>
              <section class="panel">
                <div class="panel-pad">
                  <div class="mini-eyebrow">
                    native merge queue · {windowDays}d window <span class="window-tag">(reported)</span>
                  </div>
                  {stats === undefined ? (
                    <div class="empty">
                      Queue statistics unavailable — the orchestrator read failed, or nothing has flowed through the
                      merge queue in this window yet.
                    </div>
                  ) : (
                    <>
                      <StatGrid cards={queueCards(stats)} />
                      <div class="note">
                        dequeues (left without merging): <b>{stats.dequeues.conflict}</b> conflict ·{" "}
                        <b>{stats.dequeues.blocked}</b> blocked · <b>{stats.dequeues.failed}</b> failed ·{" "}
                        <b>{stats.dequeues.superseded}</b> superseded. Batch checks that fail are bisected to isolate
                        the offending PR rather than rejecting the whole batch.
                      </div>
                    </>
                  )}
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </>
  );
}
