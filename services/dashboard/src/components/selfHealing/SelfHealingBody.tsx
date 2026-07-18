/**
 * bh-14b — the Self-Healing overview body: the org-wide funnel plus a loop table.
 *
 * The funnel (opened → reproduced → fixed → merged → deployed → symptom-verified →
 * source-closed) is rendered from the real org-scoped orchestrator aggregate.
 * Each row's bar is scaled against `opened` (the base), so a drop between stages
 * IS the visible signal — e.g. loops that deployed but whose symptom verification
 * failed never reach `symptom_verified`.
 */

import type { FunnelCounts, LoopSummary, SelfHealingFunnel, SelfHealingStage } from "../../api/selfHealing.js";
import { SELF_HEALING_STAGES } from "../../api/selfHealing.js";
import { SELF_HEALING_SCREEN_CSS } from "./styles.js";

export interface SelfHealingBodyProps {
  funnel: SelfHealingFunnel | undefined;
  orgLogin: string;
  /** Whether the operator has a visible org at all. */
  noOrg: boolean;
}

const STAGE_LABEL: Readonly<Record<SelfHealingStage, string>> = {
  opened: "opened",
  reproduced: "reproduced",
  fixed: "fixed",
  merged: "merged",
  deployed: "deployed",
  symptom_verified: "symptom-verified",
  source_closed: "source-closed",
};

function pct(count: number, base: number): number {
  if (base <= 0) return 0;
  return Math.round((count / base) * 100);
}

function FunnelBars(props: { counts: FunnelCounts }) {
  const base = props.counts.opened;
  let prev = base;
  return (
    <div class="funnel">
      {SELF_HEALING_STAGES.map((stage) => {
        const count = props.counts[stage];
        const dropped = count < prev;
        prev = count;
        return (
          <div class={`funnel-row${dropped ? " drop" : ""}`} data-stage={stage}>
            <span class="stage">{STAGE_LABEL[stage]}</span>
            <span class="track">
              <span class="fill" style={`width:${pct(count, base)}%`}></span>
            </span>
            <span class="count" data-count={String(count)}>
              {count}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function LoopRow(props: { loop: LoopSummary }) {
  const { loop } = props;
  const href = `/self-healing/projects/${encodeURIComponent(loop.projectId)}/loops/${encodeURIComponent(loop.loopId)}`;
  const symptom = loop.badges?.symptom ?? "—";
  return (
    <tr data-loop={loop.loopId}>
      <td>
        <a href={href}>{loop.loopId}</a>
      </td>
      <td>{loop.projectId}</td>
      <td>{loop.state}</td>
      <td>{loop.severity}</td>
      <td>{STAGE_LABEL[loop.furthestStage]}</td>
      <td data-symptom={symptom}>{symptom}</td>
    </tr>
  );
}

export function SelfHealingBody(props: SelfHealingBodyProps) {
  const { funnel, orgLogin, noOrg } = props;
  return (
    <>
      <style data-screen="self-healing" dangerouslySetInnerHTML={{ __html: SELF_HEALING_SCREEN_CSS }} />
      <div class="page-head">
        <div>
          <div class="eyebrow">✦ org · self-healing · {orgLogin || "no org"}</div>
          <div class="page-title">how issues close themselves</div>
        </div>
      </div>
      <div class="page-body">
        <div class="self-healing">
          {noOrg || funnel === undefined ? (
            <section class="panel">
              <div class="panel-pad">
                <div class="empty">
                  No self-healing activity visible yet. Once issue loops open — a source finding lands, gets reproduced,
                  fixed, merged, deployed, and its symptom re-verified in production — the funnel and per-loop causal
                  proof render here from the real org-scoped resolution evidence.
                </div>
              </div>
            </section>
          ) : (
            <>
              <section class="panel">
                <div class="panel-pad">
                  <div class="mini-eyebrow">
                    resolution funnel · {funnel.funnel.totalLoops} issue loop
                    {funnel.funnel.totalLoops === 1 ? "" : "s"}
                  </div>
                  <FunnelBars counts={funnel.funnel.counts} />
                  <div class="empty">
                    Each bar counts loops that reached at least that stage. A drop into <b>symptom-verified</b> is the
                    false-green catch: a cosmetic fix can merge + deploy (green) while its production symptom stays
                    failed — it never crosses this stage.
                  </div>
                </div>
              </section>
              <section class="panel">
                <div class="panel-pad">
                  <div class="mini-eyebrow">issue loops</div>
                  {funnel.funnel.loops.length === 0 ? (
                    <div class="empty">No issue loops yet.</div>
                  ) : (
                    <table class="loops">
                      <thead>
                        <tr>
                          <th>loop</th>
                          <th>project</th>
                          <th>state</th>
                          <th>severity</th>
                          <th>furthest stage</th>
                          <th>symptom</th>
                        </tr>
                      </thead>
                      <tbody>
                        {funnel.funnel.loops.map((loop) => (
                          <LoopRow loop={loop} />
                        ))}
                      </tbody>
                    </table>
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
