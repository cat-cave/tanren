/**
 * the live "what forge captured" panel (step 1 right rail). Renders
 * the accumulated interview capture: identity, personas, behaviors, interfaces,
 * design-DNA, architecture, rulesets. Each section shows a done/live/empty
 * glyph so the operator watches the capture fill as the interview progresses
 * (the hi-fi `view-onboard-new` extract panel). Pure render over the capture —
 * no state of its own.
 */

import type { InterviewCapture } from "../../../api/onboardingNewTypes.js";

function Card(props: { ch: string; filled: boolean; live?: boolean; children?: unknown }) {
  const glyph = props.live === true ? "↻" : props.filled ? "✓" : "✎";
  const color = props.live === true ? "var(--ember-08)" : props.filled ? "var(--status-ok)" : "var(--fg-3)";
  return (
    <div class={`gf-card${props.live === true ? " live" : ""}`} data-capture-card={props.ch}>
      <div class="h">
        <span class="gl" style={`color:${color}`}>
          {glyph}
        </span>
        <span class="ch">{props.ch}</span>
      </div>
      {props.children}
    </div>
  );
}

export function CapturePanel(props: { capture: InterviewCapture }) {
  const c = props.capture;
  return (
    <div class="gf-capture" data-capture-panel>
      <div class="label">▮ what forge captured · live</div>

      <Card ch="identity" filled={c.identity !== null}>
        {c.identity === null ? (
          <div class="empty">not captured yet</div>
        ) : (
          <div class="body">
            <div style="font-family:var(--font-display);font-weight:700;font-size:15px;color:var(--fg-1);text-transform:lowercase">
              {c.identity.slug}
            </div>
            <div>{c.identity.pitch}</div>
            {c.identity.repoHint !== "" && <div style="color:var(--fg-3)">repo · {c.identity.repoHint}</div>}
          </div>
        )}
      </Card>

      <Card ch={`personas · ${c.personas.length}`} filled={c.personas.length > 0}>
        {c.personas.length === 0 ? (
          <div class="empty">not captured yet</div>
        ) : (
          <div class="body">
            {c.personas.map((p) => (
              <div>
                <span style="color:var(--fg-1)">{p.name}</span>
                {p.surface !== "" && <span style="color:var(--fg-3)"> · {p.surface}</span>}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card ch={`behaviors · ${c.behaviors.length}`} filled={c.behaviors.length > 0} live={c.behaviors.length > 0}>
        {c.behaviors.length === 0 ? (
          <div class="empty">not captured yet · these become bdd scenarios in the dag</div>
        ) : (
          <div class="body">
            {c.behaviors.slice(0, 8).map((b) => (
              <div>
                <span style="color:var(--ember-08)">{b.persona}</span> · {b.title}
              </div>
            ))}
            {c.behaviors.length > 8 && <div style="color:var(--fg-3)">… {c.behaviors.length - 8} more</div>}
          </div>
        )}
      </Card>

      <Card ch={`interfaces · ${c.interfaces.length}`} filled={c.interfaces.length > 0}>
        {c.interfaces.length === 0 ? (
          <div class="empty">inferred from personas</div>
        ) : (
          <div class="body">
            {c.interfaces.map((i) => (
              <div>
                ▸ {i.name}
                {i.note !== "" && <span style="color:var(--fg-3)"> · {i.note}</span>}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card ch="design dna" filled={c.designDna !== ""}>
        {c.designDna === "" ? <div class="empty">pick a starter</div> : <div class="body">{c.designDna}</div>}
      </Card>

      <Card ch="architecture" filled={c.architecture.length > 0}>
        {c.architecture.length === 0 ? (
          <div class="empty">forge proposes after personas + interfaces</div>
        ) : (
          <div class="body">
            {c.architecture.map((a) => (
              <div>
                <span style="color:var(--fg-3)">{a.layer}</span> · {a.choice}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card ch="rulesets" filled={c.rulesets.length > 0}>
        {c.rulesets.length === 0 ? (
          <div class="empty">required · tanren can't operate without these</div>
        ) : (
          <div class="body">
            {c.rulesets.map((r) => (
              <div>
                <span style="color:var(--status-ok)">●</span> {r}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
