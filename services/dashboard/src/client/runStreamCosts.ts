/** DOM projection for the shared exact run cost model. */
import { formatMicros, formatTokens, type BillingMode, type CostTotalsState } from "./runCostModel.js";

export * from "./runCostModel.js";

const SOURCE_VAR: Record<BillingMode, string> = {
  per_token: "var(--cost-token)",
  subscription: "var(--cost-window)",
  self_hosted: "var(--cost-opportunity)",
  unattributed: "var(--cost-unattributed, var(--status-fail))",
};
const SOURCE_LABEL: Record<BillingMode, string> = {
  per_token: "per-token",
  subscription: "window",
  self_hosted: "self-hosted",
  unattributed: "unattributed",
};

function setText(root: HTMLElement, key: string, text: string): void {
  const element = root.querySelector<HTMLElement>(`[data-rd="${key}"]`);
  if (element !== null) element.textContent = text;
}

export function renderCostBar(root: HTMLElement, totals: CostTotalsState): void {
  const document = root.ownerDocument;
  const sourceRows = [...totals.bySource].map(([mode, aggregate]) => {
    const row = document.createElement("div");
    row.className = "source-row";
    const swatch = document.createElement("span");
    swatch.className = "sw";
    swatch.style.background = SOURCE_VAR[mode];
    const label = document.createElement("span");
    label.textContent = SOURCE_LABEL[mode];
    const amount = document.createElement("span");
    amount.className = "amt";
    amount.textContent = `${formatTokens(aggregate.tokens)} tok${aggregate.microUsd > 0n ? ` · ${formatMicros(aggregate.microUsd)}` : ""}`;
    row.append(swatch, label, amount);
    return row;
  });
  const modelRows = [...totals.byModel].map(([model, aggregate]) => {
    const row = document.createElement("div");
    row.className = "source-row";
    const label = document.createElement("span");
    label.textContent = model;
    const amount = document.createElement("span");
    amount.className = "amt";
    amount.textContent = `${formatTokens(aggregate.tokens)} tok`;
    row.append(label, amount);
    return row;
  });
  const denominator = totals.inputTokens + totals.outputTokens;
  const inPct = denominator === 0 ? 0 : (totals.inputTokens / denominator) * 100;
  setText(root, "cost-per-token", formatMicros(totals.perTokenMicros));
  setText(root, "cost-per-token-tokens", `${totals.bySource.get("per_token")?.tokens ?? 0} tok`);
  setText(root, "cost-subscription-tokens", formatTokens(totals.bySource.get("subscription")?.tokens ?? 0));
  setText(root, "cost-tokens", `${formatTokens(totals.inputTokens)} / ${formatTokens(totals.outputTokens)}`);
  setText(
    root,
    "cost-token-foot",
    `cached ${formatTokens(totals.cachedInputTokens)} · total ${formatTokens(totals.totalTokens)}`,
  );
  const spendBar = root.querySelector<HTMLElement>('[data-rd="cost-per-token-bar"]');
  if (spendBar !== null) spendBar.style.width = `${Math.min(100, Number(totals.perTokenMicros) / 10_000).toFixed(1)}%`;
  const inputBar = root.querySelector<HTMLElement>('[data-rd="cost-input-bar"]');
  if (inputBar !== null) inputBar.style.width = `${inPct.toFixed(1)}%`;
  const outputBar = root.querySelector<HTMLElement>('[data-rd="cost-output-bar"]');
  if (outputBar !== null) outputBar.style.width = `${(100 - inPct).toFixed(1)}%`;
  root.querySelector<HTMLElement>('[data-rd="cost-sources"]')?.replaceChildren(...sourceRows);
  root.querySelector<HTMLElement>('[data-rd="cost-models"]')?.replaceChildren(...modelRows);
}
