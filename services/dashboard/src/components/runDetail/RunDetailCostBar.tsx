import type { RunDetail } from "../../api/types.js";
import { costSourceLabel, costSourceVar, formatDuration, formatMicros, formatTokens, summarizeCosts } from "./model.js";

export function RunDetailCostBar(props: { detail: RunDetail }) {
  const { detail } = props;
  const totals = summarizeCosts(detail.costs);
  const liveTask = detail.tasks.find((task) => task.status === "running" || task.status === "claimed");
  const attempts = detail.tasks.reduce((max, task) => Math.max(max, task.attempt + 1), 1);
  const retries = detail.tasks.reduce((sum, task) => sum + task.attempt, 0);
  const denominator = totals.inputTokens + totals.outputTokens;
  const inPct = denominator === 0 ? 0 : (totals.inputTokens / denominator) * 100;
  return (
    <div class="cost-bar" data-rd="cost-bar">
      <div class="cost-cell">
        <div class="row1">
          <span class="swatch" style="background: var(--cost-token)"></span>
          <span class="l" style="color: var(--cost-token)">
            per-token
          </span>
          <span class="v" data-rd="cost-per-token">
            {formatMicros(totals.perTokenMicros)}
          </span>
        </div>
        <div class="bar">
          <i
            data-rd="cost-per-token-bar"
            style={`width: ${Math.min(100, Number(totals.perTokenMicros) / 10_000).toFixed(1)}%; background: var(--cost-token)`}
          ></i>
        </div>
        <div class="k">
          real-dollar spend ·{" "}
          <span data-rd="cost-per-token-tokens">{totals.bySource.get("per_token")?.tokens ?? 0} tok</span>
        </div>
      </div>
      <div class="cost-cell">
        <div class="row1">
          <span class="swatch" style="background: var(--cost-window)"></span>
          <span class="l" style="color: var(--cost-window)">
            window
          </span>
          <span class="v" data-rd="cost-subscription-tokens">
            {formatTokens(totals.bySource.get("subscription")?.tokens ?? 0)}
          </span>
        </div>
        <div class="source-rows" data-rd="cost-sources">
          {[...totals.bySource.entries()].map(([mode, aggregate]) => (
            <div class="source-row">
              <span class="sw" style={`background: ${costSourceVar(mode)}`}></span>
              <span>{costSourceLabel(mode)}</span>
              <span class="amt">
                {formatTokens(aggregate.tokens)} tok
                {aggregate.microUsd > 0n ? ` · ${formatMicros(aggregate.microUsd)}` : ""}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div class="cost-cell">
        <div class="row1">
          <span class="l" style="color: var(--fg-3)">
            tokens · in / out
          </span>
          <span class="v" data-rd="cost-tokens">
            {formatTokens(totals.inputTokens)} / {formatTokens(totals.outputTokens)}
          </span>
        </div>
        <div class="bar" style="display:flex; gap:2px;">
          <i data-rd="cost-input-bar" style={`width:${inPct.toFixed(1)}%; background: var(--line-2)`}></i>
          <i data-rd="cost-output-bar" style={`width:${(100 - inPct).toFixed(1)}%; background: var(--cost-token)`}></i>
        </div>
        <div class="k" data-rd="cost-token-foot">
          cached {formatTokens(totals.cachedInputTokens)} · total {formatTokens(totals.totalTokens)}
        </div>
      </div>
      <div class="cost-cell">
        <div class="row1">
          <span class="l" style="color: var(--fg-3)">
            by model
          </span>
        </div>
        <div class="source-rows" data-rd="cost-models">
          {totals.byModel.size === 0 ? (
            <div class="source-row">
              <span>no cost records yet</span>
            </div>
          ) : (
            [...totals.byModel.entries()].map(([model, aggregate]) => (
              <div class="source-row">
                <span>{model}</span>
                <span class="amt">{formatTokens(aggregate.tokens)} tok</span>
              </div>
            ))
          )}
        </div>
      </div>
      <div class="cost-cell meta-cell">
        <div class="grid">
          <span class="k">cli</span>
          <b>{liveTask?.cli ?? detail.tasks[0]?.cli ?? "—"}</b>
          <span class="k">attempt</span>
          <b data-rd="meta-attempt">{attempts}</b>
          <span class="k">elapsed</span>
          <b data-rd="meta-elapsed">{formatDuration(detail.run.startedAt, detail.run.endedAt) || "—"}</b>
          <span class="k">retries</span>
          <b style={retries > 0 ? "color: var(--status-warn)" : "color: var(--status-ok)"}>{retries}</b>
        </div>
      </div>
    </div>
  );
}
