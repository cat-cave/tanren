/**
 * costs dashboard body. Renders the all-sources cost picture from
 * aggregated records: total + per-source stacked bar, per-pricing-model
 * source cards (the three §4 cost models), per-provider breakdown table (every
 * row shows its REAL cost source), burn projection, headroom, and the observed-
 * metrics stub. Presentation only — figures come from `aggregate.ts`.
 */

import { COST_BASIS_META, type CostSummary, type BurnProjection, type ObservedMetrics } from "./aggregate.js";
import { pct, tokens, usd } from "./format.js";
import { HeatmapPanel } from "./HeatmapPanel.js";
import type { HeatmapMatrix } from "./heatmap.js";
import { COSTS_SCREEN_CSS } from "./styles.js";

export interface CostsBodyProps {
  summary: CostSummary;
  burn: BurnProjection;
  metrics: ObservedMetrics;
  /** subscription-window utilization heatmap (30d × 5-window). */
  heatmap: HeatmapMatrix;
  /** Active date-range pill (7d / 30d / 90d / all). */
  range: string;
  /** Org login for the eyebrow scope line. */
  orgLogin: string;
  /** True when at least one project's run list failed (spend may be under-counted). */
  costsUnavailable: boolean;
  /** True when a cost page walk was incomplete (figures are partial). */
  costsPartial: boolean;
}

const RANGES: { id: string; label: string }[] = [
  { id: "7d", label: "7d" },
  { id: "30d", label: "30d" },
  { id: "90d", label: "90d" },
  { id: "all", label: "all" },
];

export function CostsBody(props: CostsBodyProps) {
  const { summary, burn, metrics, range, heatmap } = props;
  const empty = summary.totalRecords === 0;
  const unavailable = props.costsUnavailable || props.costsPartial;
  return (
    <>
      <style data-screen="costs" dangerouslySetInnerHTML={{ __html: COSTS_SCREEN_CSS }} />
      <div class="page-head">
        <div>
          <div class="eyebrow">▮ history · cost of forging · all sources · {props.orgLogin || "org"}</div>
          <div class="page-title">where the money goes</div>
        </div>
        <div class="filters">
          {RANGES.map((r) => (
            <a class={`pill${r.id === range ? " hot" : ""}`} href={`/costs?range=${r.id}`}>
              {r.label}
            </a>
          ))}
          <a class="btn" href="/costs/export.csv">
            export csv
          </a>
        </div>
      </div>
      <div class="page-body">
        <div class="costs-screen">
          {unavailable ? (
            <section class="panel">
              <div class="empty" role="alert" data-costs-unavailable>
                {props.costsUnavailable
                  ? "Cost picture is incomplete — at least one project's run list failed, so spend may be under-counted. This is not zero spend."
                  : "Cost picture is partial — a cost page walk did not complete, so the figures below under-count. This is not the full total."}
              </div>
            </section>
          ) : empty ? (
            <section class="panel">
              <div class="empty">
                No cost records yet. Once a run forges with a wired credential, every call lands a cost record here —
                priced when the basis is known, token-only when it is honestly unknown.
              </div>
            </section>
          ) : (
            <>
              <TotalSpendPanel summary={summary} burn={burn} />
              <HeatmapPanel matrix={heatmap} />
              <div class="split-row">
                <ProviderBreakdown summary={summary} />
                <div class="scroll-col">
                  <BurnPanel burn={burn} />
                  <HeadroomPanel summary={summary} />
                  <ObservedPanel metrics={metrics} />
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function TotalSpendPanel(props: { summary: CostSummary; burn: BurnProjection }) {
  const { summary } = props;
  // Vocabulary discipline (FOCUS): the headline LEADS with real spend, unless real
  // is $0 and there is an equivalent figure (a subscription/Teams org) — then it
  // leads with the API-EQUIVALENT estimate so the org never sees a misleading "$0".
  // Both figures are always shown; this only picks which one is the big number.
  const leadEquivalent = summary.headlineBasis === "equivalent";
  const headlineUsd = leadEquivalent ? summary.totalNotionalUsd : summary.totalUsd;
  const headlineLabel = leadEquivalent ? "equivalent · api-priced estimate" : "real spend · billed";
  const secondaryUsd = leadEquivalent ? summary.totalUsd : summary.totalNotionalUsd;
  const secondaryLabel = leadEquivalent ? "real spend (billed)" : "equivalent (api-priced)";
  // The stacked bar weights each model by its share of the LED figure so an
  // all-subscription org gets a populated bar (notional shares) rather than an
  // empty one. A model with no value on the led axis still shows in the cards below.
  const segModels = summary.models.filter((m) => (leadEquivalent ? m.notionalUsd > 0 : m.costUsd > 0));
  const segShare = (m: (typeof summary.models)[number]) => (leadEquivalent ? m.notionalShare : m.share);
  return (
    <section class="panel">
      <div class="total-head">
        <div class="total-figs">
          <span class="total-eyebrow">
            {headlineLabel} · {summary.totalRuns} runs
          </span>
          <span class="total-amount">{usd(headlineUsd)}</span>
          <span class="total-note">
            {secondaryLabel} {usd(secondaryUsd)} · {tokens(summary.totalTokens)} tokens · {summary.totalRecords} calls
          </span>
        </div>
        <span class="total-scope">across {summary.models.filter((m) => m.records > 0).length} cost sources</span>
      </div>
      <div class="cost-stacked">
        {segModels.map((m, i) => (
          <span style={`flex:${Math.max(1, Math.round(segShare(m) * 10000))};background:${m.meta.colorVar}`}>
            {i === 0 && segShare(m) >= 0.12 ? <span class="seg-label">{pct(segShare(m))}</span> : null}
          </span>
        ))}
      </div>
      <div class="source-cards">
        {summary.models.map((m) => {
          // Lead each card with REAL spend; when a model has none (subscription /
          // self-hosted), surface its API-EQUIVALENT estimate rather than $0 — kept
          // explicitly labelled "equiv" so notional is never mistaken for spend.
          const showReal = m.costUsd > 0;
          const showEquiv = !showReal && m.notionalUsd > 0;
          return (
            <div class="source-card">
              <div class="top">
                <span class="swatch" style={`background:${m.meta.colorVar}`}></span>
                <span class="l" style={`color:${m.meta.colorVar}`}>
                  {m.meta.label}
                </span>
              </div>
              <div class="v">
                {showReal ? usd(m.costUsd) : showEquiv ? `${usd(m.notionalUsd)} equiv` : `${tokens(m.totalTokens)} tok`}
              </div>
              <div class="k">
                {m.meta.hint} · {m.records > 0 ? pct(showReal ? m.share : m.notionalShare) : "—"}
              </div>
              <div class="basis">{m.meta.model}</div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ProviderBreakdown(props: { summary: CostSummary }) {
  const { summary } = props;
  return (
    <section class="panel">
      <div class="panel-head">
        <h3>
          breakdown · <em>by provider</em>
        </h3>
        <span class="meta">per-token + window-equiv + opportunity · every row sourced</span>
      </div>
      <div class="cost-table-head">
        <span>cli · model · auth</span>
        <span class="num">runs</span>
        <span class="num">tokens</span>
        <span class="num">$ / equiv</span>
        <span class="num">share</span>
      </div>
      <div>
        {summary.providers.map((row) => {
          const basisMeta = COST_BASIS_META[row.costBasis];
          const colorVar = modelColor(row.billingMode);
          return (
            <div class="cost-table-row">
              <span class="label">
                <span class="dot" style={`background:${colorVar}`}></span>
                <span class="triple">
                  {row.cli} · {row.model} · {row.provider}
                </span>
                <span class="basis-tag">{basisMeta.label}</span>
              </span>
              <span class="num">{row.runs}</span>
              <span class="num">{tokens(row.totalTokens)}</span>
              <span class={`num ${row.priced ? "hi" : "unpriced"}`}>
                {row.priced ? usd(row.costUsd) : "no $ basis"}
              </span>
              <span class="num">{row.costUsd > 0 ? pct(row.share) : "—"}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function modelColor(mode: string): string {
  if (mode === "per_token") return "var(--cost-token)";
  if (mode === "subscription") return "var(--cost-window)";
  // BUDGET-SAFETY C1: an unrecognized credential ref (a misconfig) — distinct color.
  if (mode === "unattributed") return "var(--cost-unattributed, var(--status-fail))";
  return "var(--cost-opportunity)";
}

function BurnPanel(props: { burn: BurnProjection }) {
  const { burn } = props;
  // The spark scales to whichever axis is taller so an all-subscription org (real
  // spend $0, notional > 0) still gets a populated sparkline. Each bar overlays the
  // REAL bucket on the NOTIONAL one — real money inside the equivalent envelope.
  const max = Math.max(0.01, ...burn.daily.map((d) => Math.max(d.usd, d.notionalUsd)));
  return (
    <section class="panel">
      <div class="panel-pad">
        <div class="panel-head" style="border-bottom:none;padding:0">
          <h3>burn + forecast</h3>
          <span class="meta" style="color:var(--status-ok)">
            {burn.activeDays} active days
          </span>
        </div>
        <div class="spark">
          {burn.daily.map((d) => (
            <span
              style={`height:${Math.round((d.notionalUsd / max) * 100)}%`}
              title={`${d.day} · ${usd(d.usd)} real · ${usd(d.notionalUsd)} equiv`}
            >
              <span class="spark-real" style={`height:${Math.round((d.usd / Math.max(0.01, d.notionalUsd)) * 100)}%`} />
            </span>
          ))}
        </div>
        <div class="kv">
          <span class="k">last {burn.daily.length}d · daily real</span>
          <span>{usd(burn.dailyAvgUsd)}/d avg</span>
          <span class="k">last {burn.daily.length}d · daily equiv</span>
          <span>{usd(burn.notionalDailyAvgUsd)}/d avg</span>
        </div>
        <div class="kv hairline-top">
          <span class="k">this month · real spend</span>
          <span>{usd(burn.monthToDateUsd)}</span>
          <span class="k">this month · equivalent</span>
          <span>{usd(burn.notionalMonthToDateUsd)}</span>
        </div>
        <div class="kv hairline-top">
          <span class="k">est. month-end · real</span>
          <span>~{usd(burn.projectedRealMonthEndUsd)}</span>
          <span class="k">est. month-end · equivalent</span>
          <span>~{usd(burn.projectedNotionalMonthEndUsd)}</span>
        </div>
        <div class="note hairline-top">
          Forecast is a flat run-rate ESTIMATE — month-to-date plus the {burn.daily.length}-day daily average over the{" "}
          {burn.daysLeftInMonth} day{burn.daysLeftInMonth === 1 ? "" : "s"} left this month. Not a guarantee; no
          confidence implied. <strong>Real</strong> is money billed; <strong>equivalent</strong> is the api-list-priced
          estimate (what the same tokens would cost on metered keys).
        </div>
      </div>
    </section>
  );
}

function HeadroomPanel(props: { summary: CostSummary }) {
  const { summary } = props;
  const subscription = summary.models.find((m) => m.mode === "subscription");
  const selfHosted = summary.models.find((m) => m.mode === "self_hosted");
  return (
    <section class="panel">
      <div class="panel-pad">
        <div class="mini-eyebrow ok">headroom · subscription + self-hosted</div>
        <div class="kv">
          <span class="k">subscription · window calls</span>
          <span style="color:var(--status-ok)">
            {subscription ? `${tokens(subscription.totalTokens)} tok · ${subscription.runs} runs` : "none wired"}
          </span>
          <span class="k">self-hosted · opportunity calls</span>
          <span style="color:var(--status-ok)">
            {selfHosted ? `${tokens(selfHosted.totalTokens)} tok · ${selfHosted.runs} runs` : "none wired"}
          </span>
        </div>
        <div class="note hairline-top">
          Subscription + self-hosted capacity you've already paid for. Token volume here is use-it-or-lose-it headroom —
          routing more work to filled windows raises throughput without raising the per-token bill.
        </div>
      </div>
    </section>
  );
}

function ObservedPanel(props: { metrics: ObservedMetrics }) {
  const { metrics } = props;
  return (
    <section class="panel">
      <div class="panel-pad">
        <div class="mini-eyebrow">observed · reported, not targeted</div>
        <div class="kv">
          <span class="k">specs merged</span>
          <span>{metrics.specsMerged}</span>
          <span class="k">avg cost per merged spec</span>
          <span>{metrics.avgCostPerMergedUsd === null ? "—" : usd(metrics.avgCostPerMergedUsd)}</span>
          <span class="k">halt-rate</span>
          <span>{pct(metrics.haltRate)}</span>
          <span class="k">runs observed</span>
          <span>{metrics.totalRuns}</span>
        </div>
        <div class="note hairline-top">
          ↑ reported, not targeted · steady-state first. Full DORA panel is Phase 3; this is the v0 stub.
        </div>
      </div>
    </section>
  );
}
