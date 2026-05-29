/**
 * P3-0019 DORA-like metrics panel body. Renders the four delivery metrics —
 * lead time, deploy frequency, change-failure rate, mean time to restore —
 * derived from existing run/event data by the orchestrator (`GET .../dora`).
 *
 * REPORTED, NOT TARGETED: the panel surfaces a steady-state baseline and says
 * so explicitly. Presentation only — every figure comes from the orchestrator
 * `DoraMetrics` payload; uncomputable metrics render "—", never a fake zero.
 */

import type { DoraMetrics } from "../../api/dora.js";
import { doraDuration, doraFrequency, doraPercent } from "./format.js";
import { DORA_SCREEN_CSS } from "./styles.js";

export interface DoraBodyProps {
  /** The computed metrics, or `undefined` when the read failed / no project. */
  metrics: DoraMetrics | undefined;
  /** Active window pill (7d / 30d / 90d). */
  windowDays: number;
  /** Project name for the eyebrow scope line. */
  projectName: string;
  /** Whether the operator has a visible project at all. */
  noProject: boolean;
}

const WINDOWS: number[] = [7, 30, 90];

interface MetricCard {
  label: string;
  value: string;
  /** True when the value is the "—" no-data sentinel. */
  empty: boolean;
  sub: string;
  sample: number;
}

/** Build the four metric cards from the payload (or empty placeholders). */
function cards(m: DoraMetrics | undefined): MetricCard[] {
  const lead = m?.leadTimeSeconds.value ?? null;
  const deploy = m?.deployFrequencyPerDay.value ?? null;
  const cfr = m?.changeFailureRate.value ?? null;
  const mttr = m?.meanTimeToRestoreSeconds.value ?? null;
  return [
    {
      label: "lead time",
      value: doraDuration(lead),
      empty: lead === null,
      sub: "median spec created → merged",
      sample: m?.leadTimeSeconds.sample ?? 0,
    },
    {
      label: "deploy frequency",
      value: doraFrequency(deploy),
      empty: deploy === null,
      sub: "merges per day, this window",
      sample: m?.deployFrequencyPerDay.sample ?? 0,
    },
    {
      label: "change-failure rate",
      value: doraPercent(cfr),
      empty: cfr === null,
      sub: "finished runs that halted / failed",
      sample: m?.changeFailureRate.sample ?? 0,
    },
    {
      label: "time to restore",
      value: doraDuration(mttr),
      empty: mttr === null,
      sub: "median halt → recovery merge",
      sample: m?.meanTimeToRestoreSeconds.sample ?? 0,
    },
  ];
}

export function DoraBody(props: DoraBodyProps) {
  const { metrics, windowDays, projectName, noProject } = props;
  return (
    <>
      <style data-screen="dora" dangerouslySetInnerHTML={{ __html: DORA_SCREEN_CSS }} />
      <div class="page-head">
        <div>
          <div class="eyebrow">▮ org · delivery metrics · dora-like · {projectName || "no project"}</div>
          <div class="page-title">how delivery is flowing</div>
        </div>
        <div class="filters">
          {WINDOWS.map((w) => (
            <a class={`pill${w === windowDays ? " hot" : ""}`} href={`/dora?windowDays=${w}`}>
              {w}d
            </a>
          ))}
        </div>
      </div>
      <div class="page-body">
        <div class="dora-screen">
          {noProject ? (
            <section class="panel">
              <div class="empty">
                No project visible yet. Onboard one to start forging — once runs land and specs merge, the four DORA
                metrics compute here from the run/event history already on record.
              </div>
            </section>
          ) : (
            <section class="panel">
              <div class="panel-pad">
                <div class="mini-eyebrow">
                  observed · {windowDays}d window <span class="window-tag">(dora-like · reported, not targeted)</span>
                </div>
                <div class="dora-grid">
                  {cards(metrics).map((card) => (
                    <div class="dora-card">
                      <span class="label">{card.label}</span>
                      <span class={`value${card.empty ? " empty" : ""}`}>{card.value}</span>
                      <span class="sub">{card.sub}</span>
                      <span class="sample">n={card.sample}</span>
                    </div>
                  ))}
                </div>
                <div class="note">
                  <b>↑ reported, not targeted.</b> These are a steady-state baseline derived from the run/event history
                  you already have — no new data collection. Set targets only once a stable baseline is established (≥
                  60d of merges).
                </div>
              </div>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
