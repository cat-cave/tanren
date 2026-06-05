/**
 * brownfield step 5 — governance posture picker. Wires the
 * posture modes (strict | open | audit_only) into onboarding: the operator
 * picks one, the route persists it onto the project config, and the
 * external-push policy is DERIVED from the posture (no separate config field).
 * After saving, renders the arrival card. Recreated from the hi-fi
 * `view-onboard-existing` step 5.
 */

import type { GovernancePosture, GovernanceResult } from "../../../api/existingBrownfieldTypes.js";

interface PostureOption {
  value: GovernancePosture;
  name: string;
  body: string;
  best: string;
}

const POSTURES: PostureOption[] = [
  {
    value: "strict",
    name: "strict — you describe, we forge",
    body: "Every change goes through a spec. External pushes get warned + auto-spec'd for tracking. Tanren never reviews human PRs.",
    best: "for teams committing to the spec discipline",
  },
  {
    value: "open",
    name: "open — humans + tanren both push",
    body: "Tanren coexists. Direct pushes are normal. Tanren tracks but doesn't block them. Picks up issues + audits + operator specs.",
    best: "for established teams retrofitting tanren",
  },
  {
    value: "audit_only",
    name: "audit-only — tanren just watches",
    body: "Tanren reads everything, opens no PRs. Surfaces patterns, regressions, drift. Operator promotes findings into specs by hand.",
    best: "for a trial without code-modification risk",
  },
];

export function GovernanceStep(props: {
  projectId: string;
  repoUrl: string;
  baseAction: string;
  current: GovernancePosture;
  saved?: GovernanceResult;
}) {
  return (
    <>
      <div class="step-heading">
        <div>
          <div class="eyebrow">step 5 · governance posture</div>
          <div class="title">
            who gets to <em>commit · how</em>
          </div>
          <div class="sub">
            tanren needs a stance on how it coexists with contributors. pick a posture · override anytime from
            /settings/governance.
          </div>
        </div>
      </div>

      <div class="ex-cols">
        <form method="post" action={props.baseAction} style="display:flex;flex-direction:column;gap:10px">
          <input type="hidden" name="phase" value="governance" />
          <input type="hidden" name="step" value="5" />
          <input type="hidden" name="repoUrl" value={props.repoUrl} />
          <input type="hidden" name="projectId" value={props.projectId} />
          {POSTURES.map((p) => {
            const on = (props.saved?.governancePosture ?? props.current) === p.value;
            return (
              <label class={`ex-posture ${on ? "on" : ""}`}>
                <div class="head">
                  <input type="radio" name="posture" value={p.value} checked={on} style="display:none" />
                  <span class="radio"></span>
                  <span class="name">{p.name}</span>
                </div>
                <div class="desc">{p.body}</div>
                <div class="best">↑ best for: {p.best}</div>
              </label>
            );
          })}
          <div class="foot">
            <div class="hint">↑ external-push behavior is derived from the posture</div>
            <div class="grow"></div>
            <button type="submit" class="btn primary">
              save posture ↗
            </button>
          </div>
        </form>

        <div style="display:flex;flex-direction:column;gap:12px">
          {props.saved === undefined ? (
            <div class="col-card" style="gap:8px">
              <div class="h">
                <span>
                  external-push policy <em>· per posture</em>
                </span>
              </div>
              <div class="mono-dim" style="line-height:1.6">
                strict → external pushes warned + auto-spec'd · force-push blocked
                <br />
                open → external pushes coexist · tracked, never blocked
                <br />
                audit-only → external pushes observed · tanren opens no PRs
              </div>
            </div>
          ) : (
            <>
              <div class="alert ok">
                Posture saved · <b>{props.saved.governancePosture}</b>.
              </div>
              <div class="col-card" style="gap:8px">
                <div class="h">
                  <span>external-push policy</span>
                </div>
                <div class="ex-policy-row">
                  <span class="t">on external push</span>
                  <span class="a">{props.saved.externalPushPolicy}</span>
                </div>
              </div>
              <div class="col-card live" style="gap:8px">
                <div class="h">
                  <span>
                    repo <em>integrated</em>
                  </span>
                </div>
                <div style="font-family:var(--font-ui);font-size:12.5px;color:var(--fg-2);line-height:1.45">
                  the integration PR is the one-time gate · once merged, seed specs become runnable.
                </div>
                <div class="foot">
                  <div class="grow"></div>
                  <a class="btn primary" href={`/projects/${props.projectId}`}>
                    open project ↗
                  </a>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
