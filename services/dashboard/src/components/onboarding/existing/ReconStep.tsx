/**
 * brownfield step 2 — read-only recon. Renders the chapters the
 * read-only Answerer pre-filled (identity / personas / behaviors / architecture
 * / risks) for operator review, plus the gap cards the operator settles. A
 * signed, expiring state token rides forward on a hidden form field (transient
 * — no session table), mirroring the greenfield capture model. Recreated from the hi-fi
 * `view-onboard-existing` step 2.
 */

import type { ReconResult } from "../../../api/existingBrownfieldTypes.js";
import { CsrfField } from "../../shell/CsrfField.js";
import { StepHeading } from "../primitives.js";

function severityGlyph(severity: "info" | "warn" | "fail"): string {
  return severity === "fail" ? "!" : severity === "warn" ? "!" : "i";
}

export function ReconStep(props: {
  repoUrl: string;
  result: ReconResult;
  state: string;
  baseAction: string;
  projectId?: string;
  csrfToken?: string;
}) {
  const { report, filesIndexed } = props.result;
  return (
    <>
      <StepHeading
        eyebrow="step 2 · the agent read everything · you fill the gaps"
        title="forge already"
        em="knows most of it"
        sub={`the read-only answerer indexed ${filesIndexed} files and pre-filled the chapters below. confirm what it inferred; settle the gaps.`}
        right={
          <span class="pill cold">
            <span class="d"></span>read-only answerer · writes nothing
          </span>
        }
      />
      <div class="ex-cols">
        <div style="display:flex;flex-direction:column;gap:10px">
          <div class="ex-chapter">
            <div class="h">
              <span class="gl" style="color:var(--status-ok)">
                ✓
              </span>
              <span class="ch">identity</span>
            </div>
            <div class="body" style="color:var(--fg-1)">
              {report.identity.slug}
            </div>
            <div class="body">{report.identity.purpose}</div>
            <div class="from">↑ from {report.identity.inferredFrom}</div>
          </div>

          <div class="ex-chapter">
            <div class="h">
              <span class="gl" style="color:var(--status-ok)">
                ✓
              </span>
              <span class="ch">personas · {report.personas.length} captured</span>
            </div>
            {report.personas.map((p) => (
              <div class="body">
                <b style="color:var(--fg-1)">{p.name}</b> — {p.description}
              </div>
            ))}
          </div>

          <div class="ex-chapter">
            <div class="h">
              <span class="gl" style="color:var(--status-ok)">
                ✓
              </span>
              <span class="ch">behaviors · {report.behaviors.length} captured</span>
            </div>
            {report.behaviors.map((b) => (
              <div class="body">
                {b.persona} · {b.title}
              </div>
            ))}
          </div>

          <div class="ex-chapter">
            <div class="h">
              <span class="gl" style="color:var(--status-ok)">
                ✓
              </span>
              <span class="ch">architecture · detected</span>
            </div>
            {report.architecture.map((a) => (
              <div class="body">
                <span style="color:var(--fg-3)">{a.layer}</span> · {a.detail}
              </div>
            ))}
          </div>

          <div class="ex-chapter warn">
            <div class="h">
              <span class="gl" style="color:var(--status-warn)">
                !
              </span>
              <span class="ch">risks · {report.risks.length} flagged</span>
            </div>
            {report.risks.map((r) => (
              <div class="body">
                <span style="color:var(--status-warn);margin-right:6px">{severityGlyph(r.severity)}</span>
                {r.note}
              </div>
            ))}
          </div>
        </div>

        <div style="display:flex;flex-direction:column;gap:10px">
          <div
            class="mono-dim"
            style="font-family:var(--font-mono);color:var(--ember-08);letter-spacing:0.18em;text-transform:uppercase;font-weight:700;font-size:9px"
          >
            ▮ {report.gaps.length} things the agent couldn't decide
          </div>
          {report.gaps.map((g, i) => (
            <div class="ex-gap">
              <div class="lbl">
                ↑ gap {i + 1} · {g.chapter}
              </div>
              <div class="q">{g.question}</div>
              <div class="opts">
                {g.options.map((opt) => (
                  <span class="pill" style="font-size:10px">
                    {opt}
                  </span>
                ))}
              </div>
            </div>
          ))}

          <form method="post" action={props.baseAction}>
            <CsrfField token={props.csrfToken} />
            <input type="hidden" name="phase" value="advance" />
            <input type="hidden" name="step" value="2" />
            <input type="hidden" name="projectId" value={props.projectId ?? ""} />
            <input type="hidden" name="state" value={props.state} />
            <div class="foot">
              <div class="hint">↑ no writes happen until the config-injection PR in step 3</div>
              <div class="grow"></div>
              <button type="submit" class="btn primary">
                next · config injection pr ↗
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  );
}
