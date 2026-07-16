/**
 * config-as-code surface — the dashboard view of the tanren-config
 * audit gate. Server-rendered Hono JSX (NOT the prototype `view-config.jsx`),
 * matching its two states:
 *
 *   gate OFF → "config as code" intro card + an enable CTA, plus the
 *              dashboard-applied config history.
 *   gate ON  → forge rationale + the `tanren.yaml` diff + CI checks + impact
 *              grid + history + a merge gate ("merging applies the routing
 *              change to every new run").
 *
 * The Settings toggle lives in the SettingsBody (routing & limits); this surface
 * reads the gate state + the open config PR (if any) the route resolved.
 */

import type { PolicyIdentityReadResult } from "../../api/policyIdentityClient.js";
import { PolicyIdentityPanel } from "./PolicyIdentityPanel.js";
import { CONFIG_SCREEN_CSS } from "./styles.js";

/** One rendered `tanren.yaml` diff line (mirrors orchestrator `ConfigYamlDiffLine`). */
export interface ConfigDiffLine {
  t: "add" | "rem" | "ctx" | "comment";
  s: string;
}

/** A prior config change row for the history panel. */
export interface ConfigHistoryEntry {
  /** Short ref, e.g. `#7` or `dashboard`. */
  ref: string;
  /** Change summary. */
  summary: string;
  who: string;
  when: string;
  state: "merged" | "applied";
}

export interface ConfigViewProps {
  orgId: string;
  orgLogin: string;
  gateEnabled: boolean;
  /** The tanren-config repo target (`owner/name`), when configured. */
  repo?: string;
  configFile: string;
  /** The open config PR's branch / number, when the gate has a pending change. */
  pr?: { number: number; url: string; branch: string };
  /** Forge rationale for the pending change (gate-ON). */
  rationale?: string;
  /** The pending change as a YAML diff (gate-ON). */
  diff: ConfigDiffLine[];
  checks: string[];
  impact: { l: string; v: string; k: string }[];
  history: ConfigHistoryEntry[];
  /** gv-3: active project for the policy-identity receipt (optional when none). */
  policyProjectId?: string;
  policyProjectName?: string;
  policyIdentity?: PolicyIdentityReadResult;
}

const DIFF_CLASS: Record<ConfigDiffLine["t"], string> = {
  add: "ln-add",
  rem: "ln-rem",
  comment: "ln-comment",
  ctx: "",
};

function HistoryPanel(props: { entries: ConfigHistoryEntry[]; metaLabel: string }) {
  return (
    <div class="panel" style="padding:0;overflow:hidden">
      <div class="panel-head">
        <h3>
          config <em>history</em>
        </h3>
        <span class="meta">{props.metaLabel}</span>
      </div>
      {props.entries.map((h) => (
        <div class="config-hist-row">
          <span class="v">{h.ref}</span>
          <span class="t">{h.summary}</span>
          <span class="who">{h.who}</span>
          <span class="state">{h.state}</span>
        </div>
      ))}
    </div>
  );
}

function GateOff(props: ConfigViewProps) {
  return (
    <div class="config-screen">
      <div class="page-head">
        <div>
          <div class="eyebrow">▮ tanren-config · audit gate</div>
          <div class="title">config as code</div>
          <div class="sub">
            routing &amp; limits currently live in the dashboard · changes apply immediately, no review
          </div>
        </div>
      </div>
      <div class="panel gate-card">
        <span class="gate-eyebrow">▮ gate · off</span>
        <span class="gate-blurb">
          Forge edits routing and limits straight into the dashboard. Fast, but unreviewed. Turn the audit gate on to
          make every config change land as a reviewable PR in <code>{props.repo ?? "your tanren-config repo"}</code> —
          with schema validation, a diff, and a merge step.
        </span>
        <div class="gate-actions">
          <a class="btn primary" href="/settings/routing">
            enable audit gate ↗
          </a>
          <a class="btn" href="/settings/routing">
            edit in dashboard instead
          </a>
        </div>
      </div>
      <HistoryPanel entries={props.history} metaLabel="last changes · dashboard-applied" />
    </div>
  );
}

function GateOn(props: ConfigViewProps) {
  const added = props.diff.filter((l) => l.t === "add").length;
  const removed = props.diff.filter((l) => l.t === "rem").length;
  const hasPr = props.pr !== undefined;
  return (
    <div class="config-screen">
      <div class="page-head">
        <div>
          <div class="eyebrow">
            ▮ {hasPr ? `PR #${props.pr?.number}` : "no open change"} · {props.repo ?? "tanren-config"}
          </div>
          <div class="title">review the config change</div>
          <div class="sub">
            {props.configFile} · proposed by forge
            {hasPr ? (
              <>
                {" "}
                · branch <b>{props.pr?.branch}</b>
              </>
            ) : null}
          </div>
        </div>
        <div class="head-actions">
          {hasPr && (
            <a class="btn" href={props.pr?.url}>
              open on github ↗
            </a>
          )}
        </div>
      </div>

      {hasPr ? (
        <>
          <div class="split-row">
            <div class="scroll-col">
              <div class="forge-card">
                <div class="head">
                  <span class="stamp">鍛</span>
                  <span class="title">
                    forge · <em>proposed this</em>
                  </span>
                  <span class="meta">config pr · ci green</span>
                </div>
                <div class="body">{props.rationale ?? "A Bucket-B config change was routed through the gate."}</div>
              </div>
              <div class="panel" style="padding:0;overflow:hidden">
                <div class="panel-head">
                  <h3>
                    {props.configFile} · <em>diff</em>
                  </h3>
                  <span class="meta">
                    {added} added · {removed} removed
                  </span>
                </div>
                <div class="code-block">
                  {props.diff.map((l) => (
                    <div class={`diff-ln ${DIFF_CLASS[l.t]}`}>
                      <span class="gutter">{l.t === "add" ? "+" : l.t === "rem" ? "−" : " "}</span>
                      <span>{l.s === "" ? " " : l.s}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div class="scroll-col">
              <div class="panel panel-pad">
                <div class="spec-h">checks · green</div>
                {props.checks.map((ch) => (
                  <div class="config-check">
                    <span class="g">✓</span>
                    {ch}
                  </div>
                ))}
              </div>
              <div class="panel panel-pad">
                <div class="spec-h">impact</div>
                {props.impact.map((m) => (
                  <div class="config-impact">
                    <span class="l">{m.l}</span>
                    <span class="v">{m.v}</span>
                    <span class="k">{m.k}</span>
                  </div>
                ))}
              </div>
              <HistoryPanel entries={props.history} metaLabel="merged via tanren-config" />
            </div>
          </div>

          <div class="readiness">
            <span class="pill ok">
              <span class="d"></span>ci green
            </span>
            <span class="pill ok">
              <span class="d"></span>schema valid
            </span>
            <span class="pill warn">
              <span class="d"></span>awaiting your review
            </span>
            <span class="note">· merging applies the routing change to every new run</span>
            <div class="grow">
              <a class="btn danger" href={props.pr?.url}>
                request changes ↗
              </a>
              <a class="btn primary" href={props.pr?.url}>
                approve · merge config ↗
              </a>
            </div>
          </div>
        </>
      ) : (
        <div class="panel gate-card">
          <span class="gate-eyebrow">▮ gate · on</span>
          <span class="gate-blurb">
            The audit gate is on. The next routing or limit change Forge makes will open a PR in{" "}
            <code>{props.repo ?? "your tanren-config repo"}</code> instead of applying directly — review and merge it
            here to apply it to every new run.
          </span>
          <div class="gate-actions">
            <a class="btn" href="/settings/routing">
              propose a change ↗
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

export function ConfigView(props: ConfigViewProps) {
  return (
    <div class="p2b">
      <style data-screen="config">{CONFIG_SCREEN_CSS}</style>
      {props.gateEnabled ? <GateOn {...props} /> : <GateOff {...props} />}
      <PolicyIdentityPanel
        projectId={props.policyProjectId}
        projectName={props.policyProjectName}
        result={props.policyIdentity}
      />
    </div>
  );
}
