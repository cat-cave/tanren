/**
 * P2B-0005 costs dashboard body. Renders the all-sources cost picture from
 * aggregated P2A-0011 records: total + per-source stacked bar, per-pricing-model
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
  /** P3-0018 subscription-window utilization heatmap (30d × 5-window). */
  heatmap: HeatmapMatrix;
  /** Active date-range pill (7d / 30d / 90d / all). */
  range: string;
  /** Org login for the eyebrow scope line. */
  orgLogin: string;
}

const RANGES: { id: string; label: string }[] = [
  { id: "7d", label: "7d" },
  { id: "30d", label: "30d" },
  { id: "90d", label: "90d" },
  { id: "all", label: "all" }
];

export function CostsBody(props: CostsBodyProps) {
  const { summary, burn, metrics, range, heatmap } = props;
  const empty = summary.totalRecords === 0;
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
          {empty ? (
            <section class="panel">
              <div class="empty">
                No cost records yet. Once a run forges with a wired credential, every call lands a
                cost record here — priced when the basis is known, token-only when it is honestly
                unknown.
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
  const total = summary.totalUsd;
  // The stacked bar weights each model by its priced spend; a model with no
  // priced dollars (e.g. all-subscription) still shows in the cards below with
  // its token volume so it is never invisible.
  const pricedModels = summary.models.filter((m) => m.costUsd > 0);
  return (
    <section class="panel">
      <div class="total-head">
        <div class="total-figs">
          <span class="total-eyebrow">total · {summary.totalRuns} runs</span>
          <span class="total-amount">{usd(total)}</span>
          <span class="total-note">
            {tokens(summary.totalTokens)} tokens · {summary.totalRecords} priced+unpriced calls
          </span>
        </div>
        <span class="total-scope">across {summary.models.filter((m) => m.records > 0).length} cost sources</span>
      </div>
      <div class="cost-stacked">
        {pricedModels.map((m, i) => (
          <span style={`flex:${Math.max(1, Math.round(m.share * 10000))};background:${m.meta.colorVar}`}>
            {i === 0 && m.share >= 0.12 ? <span class="seg-label">{pct(m.share)}</span> : null}
          </span>
        ))}
      </div>
      <div class="source-cards">
        {summary.models.map((m) => (
          <div class="source-card">
            <div class="top">
              <span class="swatch" style={`background:${m.meta.colorVar}`}></span>
              <span class="l" style={`color:${m.meta.colorVar}`}>
                {m.meta.label}
              </span>
            </div>
            <div class="v">{m.costUsd > 0 ? usd(m.costUsd) : `${tokens(m.totalTokens)} tok`}</div>
            <div class="k">
              {m.meta.hint} · {m.records > 0 ? pct(m.share) : "—"}
            </div>
            <div class="basis">{m.meta.model}</div>
          </div>
        ))}
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
  return "var(--cost-opportunity)";
}

function BurnPanel(props: { burn: BurnProjection }) {
  const { burn } = props;
  const max = Math.max(0.01, ...burn.daily.map((d) => d.usd));
  return (
    <section class="panel">
      <div class="panel-pad">
        <div class="panel-head" style="border-bottom:none;padding:0">
          <h3>burn projection</h3>
          <span class="meta" style="color:var(--status-ok)">
            {burn.activeDays} active days
          </span>
        </div>
        <div class="spark">
          {burn.daily.map((d) => (
            <span style={`height:${Math.round((d.usd / max) * 100)}%`} title={`${d.day} · ${usd(d.usd)}`}></span>
          ))}
        </div>
        <div class="kv">
          <span class="k">last {burn.daily.length}d · daily spend</span>
          <span>{usd(burn.dailyAvgUsd)}/d avg</span>
        </div>
        <div class="kv hairline-top">
          <span class="k">this month · priced</span>
          <span>{usd(burn.monthToDateUsd)}</span>
          <span class="k">next 30d projection</span>
          <span>{usd(burn.projected30dUsd)}</span>
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
          Subscription + self-hosted capacity you've already paid for. Token volume here is
          use-it-or-lose-it headroom — routing more work to filled windows raises throughput without
          raising the per-token bill.
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
          ↑ reported, not targeted · steady-state first. Full DORA panel is Phase 3; this is the v0
          stub.
        </div>
      </div>
    </section>
  );
}
