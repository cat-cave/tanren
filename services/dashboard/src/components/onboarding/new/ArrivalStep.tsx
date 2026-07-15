/**
 * step 3 of the greenfield track: SOURCES, AUDITS, DORA, ARRIVAL. The
 * derived project is real now, so this closes the flow: issue sources that feed
 * the DAG, the scheduled-audit library, DORA shown as observed-not-targeted,
 * and the arrival card ("your smithy is ready · N specs, 1 ready"). The arrival
 * action links into the live project's DAG — the flow is done. The
 * source/audit toggles here are the visual entry points to their owning
 * surfaces (inbox / audits), not re-implementations of them.
 */

const ISSUE_SOURCES: Array<{ n: string; on: boolean; route: string; glyph: string }> = [
  { n: "operator manual", on: true, route: "ad-hoc · routes via interview", glyph: "✎" },
  { n: "github issues", on: true, route: "label:bug→p1 · feature→backlog", glyph: "⌥" },
  { n: "linear", on: false, route: "oauth + workspace pick → labels", glyph: "▱" },
  { n: "jira", on: false, route: "api token + project key → issue type", glyph: "◇" },
  { n: "custom webhook", on: false, route: "any json · tanren classifies", glyph: "↗" },
];

const AUDITS: Array<{ n: string; agent: string; on: boolean }> = [
  { n: "security audit", agent: "snyk + trivy + sast · weekly", on: true },
  { n: "mutation tests", agent: "stryker · pkg-aware · nightly", on: true },
  { n: "dependency updates", agent: "renovate · auto-spec · daily", on: true },
  { n: "stale specs", agent: "forge · review > 30d · weekly", on: true },
  { n: "perf benchmark", agent: "lighthouse + k6 · monthly", on: false },
  { n: "a11y", agent: "axe + pa11y · weekly", on: false },
];

const DORA: Array<[string, string]> = [
  ["lead time", "no runs yet"],
  ["deploy frequency", "first deploy sets baseline"],
  ["change failure rate", "—"],
  ["mttr", "—"],
];

export interface ArrivalStepProps {
  projectId: string;
  projectName: string;
  specCount: number;
  readyCount: number;
  unavailable?: boolean;
}

export function ArrivalStep(props: ArrivalStepProps) {
  return (
    <>
      <div class="step-heading">
        <div>
          <div class="eyebrow">step 3 · sources, audits, arrival</div>
          <div class="title">
            open the <em>floodgates</em>
          </div>
          <div class="sub">
            issue sources feed the dag · scheduled audits run in their own lanes · dora is reported, not targeted.
          </div>
        </div>
        <span class="pill ok">
          <span class="d"></span>arrival · ready to forge
        </span>
      </div>

      <div class="gf-cols3">
        <div class="gf-panel" data-arrival-sources>
          <div class="ph">
            issue <em>sources</em>
          </div>
          {ISSUE_SOURCES.map((s) => (
            <div class={`gf-row${s.on ? " on" : ""}`}>
              <span style="font-family:var(--font-mono)">{s.glyph}</span>
              <div>
                <div class="name">{s.n}</div>
                <div class="desc">{s.route}</div>
              </div>
              <span class="badge">{s.on ? "on" : "off"}</span>
            </div>
          ))}
        </div>

        <div class="gf-panel" data-arrival-audits>
          <div class="ph">
            <a href="/audits" style="color:inherit;text-decoration:none">
              scheduled <em>audits</em> ↗
            </a>
          </div>
          {AUDITS.map((a) => (
            <div class={`gf-row${a.on ? " on" : ""}`}>
              <span style="font-family:var(--font-mono)">⌬</span>
              <div>
                <div class="name">{a.n}</div>
                <div class="desc">agent · {a.agent}</div>
              </div>
              <span class="badge">{a.on ? "on" : "off"}</span>
            </div>
          ))}
        </div>

        <div style="display:flex;flex-direction:column;gap:12px">
          <div class="gf-panel" data-arrival-dora>
            <div class="ph">
              dora · <em>observed</em>
            </div>
            {DORA.map(([k, hint]) => (
              <div class="gf-row">
                <span></span>
                <div>
                  <div class="name">{k}</div>
                  <div class="desc">{hint}</div>
                </div>
                <span class="badge">—</span>
              </div>
            ))}
            <div class="desc" style="line-height:1.45">
              ↑ steady-state first · tanren reports your numbers; targets + alerts come after a few weeks.
            </div>
          </div>

          <div
            class="gf-arrival"
            data-arrival-card
            {...(props.unavailable === true ? { role: "alert", "aria-live": "polite" } : {})}
          >
            <div class="eyebrow">{props.unavailable === true ? "dag unavailable" : "your smithy is ready"}</div>
            <div class="display">
              {props.unavailable === true ? (
                <>
                  graph read
                  <br />
                  <em>unavailable</em>.
                </>
              ) : (
                <>
                  {props.specCount} specs.
                  <br />
                  <em>{props.readyCount} ready</em>.
                </>
              )}
            </div>
            <div class="sub" id="arrival-status-hint">
              {props.unavailable === true
                ? `${props.projectName} exists, but the live DAG read failed. Reload before starting work; this is not an empty project.`
                : `${props.projectName} is live · tanren will pick a ready leaf spec and start when you light the fire.`}
            </div>
            {props.unavailable === true ? null : (
              <div class="actions">
                <a class="btn primary" href={`/projects/${props.projectId}?mode=dag`}>
                  open the smithy ↗
                </a>
              </div>
            )}
            <div class="footnote">
              {props.unavailable === true
                ? "↑ arrival paused until the live graph loads · open smithy stays disabled while metrics are unavailable"
                : "↑ engine paused until you click"}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
