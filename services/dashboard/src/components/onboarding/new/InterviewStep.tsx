/**
 * step 1 of the greenfield track: the multi-round Forge VISION
 * INTERVIEW. The left column is the chat (Forge's current question + the prior
 * turn + inline suggestions); the right column is the live `CapturePanel`.
 *
 * The interview is server-driven: each round is a form POST to
 * `/onboarding/new` that runs one orchestrator interview round (over the
 * injectable answerer) and re-renders with the next question + the merged
 * capture. The running capture rides on a hidden field, so pause/resume is just
 * "leave + come back to the same step with the same capture" — no client state,
 * no interview-session table.
 */

import type { InterviewCapture, InterviewSuggestion } from "../../../api/onboardingNewTypes.js";
import { CsrfField } from "../../shell/CsrfField.js";
import { CapturePanel } from "./CapturePanel.js";

// One selectable deploy provider for the derive form — sourced from the org's
// LINKED deploy integrations. `value` encodes the full selection the server
// re-parses (`providerKind::connectionId::grantId`); an empty value is "skip".
export interface DeployOption {
  value: string;
  label: string;
}

export interface InterviewStepProps {
  round: number;
  totalRounds: number;
  say: string;
  suggestions: InterviewSuggestion[];
  priorAnswer: string;
  capture: InterviewCapture;
  complete: boolean;
  /** Session CSRF for pure HTML form posts (cookie-authenticated writes). */
  csrfToken?: string;
  /** Prefill for the GitHub `owner` field (defaults to the org login). */
  ownerDefault?: string;
  /** Field-level validation error when a derive was attempted with no owner. */
  ownerError?: string;
  /** Linked deploy providers offered on the derive form ("skip" is always first). */
  deployOptions?: DeployOption[];
}

const AUTONOMY_OPTIONS: Array<[string, string]> = [
  ["auto", "auto · land autonomous (DagWalker drives)"],
  ["simulated", "simulated · autonomous, simulated merges"],
  ["human", "human · review-gated (safe default)"],
];

export function InterviewStep(props: InterviewStepProps) {
  const pct = Math.round((Math.min(props.round, props.totalRounds) / props.totalRounds) * 100);
  const captureJson = JSON.stringify(props.capture);
  return (
    <>
      <div class="step-heading">
        <div>
          <div class="eyebrow">step 1 · the interview · pauses &amp; resumes forever</div>
          <div class="title">
            forge asks <em>you answer</em>
          </div>
          <div class="sub">
            one conversation captures everything: identity, personas, behaviors, interfaces, design dna, architecture,
            rulesets. the panel updates live as forge captures.
          </div>
        </div>
      </div>

      <div class="gf-cols">
        <div class="gf-chat" data-interview-chat>
          <div class="head">
            <span class="t">product interview</span>
            <span class="meta">
              round {props.round} of ~{props.totalRounds} · {pct}% complete
            </span>
          </div>

          {props.priorAnswer !== "" && <div class="gf-turn user">{props.priorAnswer}</div>}
          <div class="gf-turn forge" data-forge-say>
            {props.say}
          </div>

          {props.complete ? (
            <form method="post" action="/onboarding/new?step=2" data-derive-form>
              <CsrfField token={props.csrfToken} />
              <input type="hidden" name="capture" value={captureJson} />
              <input type="hidden" name="phase" value="advance" />
              <div class="gf-derive-fields" data-derive-fields>
                <div class="field">
                  <label for="owner">github owner · the account that will own the new repo</label>
                  <input
                    id="owner"
                    name="owner"
                    type="text"
                    placeholder="e.g. cat-cave (an org/user your GitHub App is installed on)"
                    value={props.ownerDefault ?? ""}
                    required
                    autocomplete="off"
                    data-testid="derive-owner"
                  />
                  {props.ownerError !== undefined && (
                    <div class="hint" style="color:var(--status-warn)" data-testid="derive-owner-error">
                      {props.ownerError}
                    </div>
                  )}
                </div>
                <div class="field">
                  <label for="autonomy">autonomy</label>
                  <select id="autonomy" name="autonomy" data-testid="derive-autonomy">
                    {AUTONOMY_OPTIONS.map(([value, label]) => (
                      <option value={value} selected={value === "auto"}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
                <div class="field">
                  <label for="deploy">deploy target · from your linked integrations</label>
                  <select id="deploy" name="deploy" data-testid="derive-deploy">
                    <option value="" selected>
                      skip · decide later
                    </option>
                    {(props.deployOptions ?? []).map((o) => (
                      <option value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div class="gf-answer">
                <span class="hint">✓ interview complete · the capture is ready to derive</span>
                <button type="submit" class="btn primary">
                  derive the spec dag ↗
                </button>
              </div>
            </form>
          ) : (
            <form method="post" action="/onboarding/new?step=1">
              <CsrfField token={props.csrfToken} />
              <input type="hidden" name="capture" value={captureJson} />
              <input type="hidden" name="round" value={String(props.round + 1)} />
              <input type="hidden" name="phase" value="round" />
              {props.suggestions.length > 0 && (
                <div class="gf-suggest" data-interview-suggestions>
                  {props.suggestions.map((s: InterviewSuggestion) => (
                    <button type="submit" name="answer" value={s.value} class="btn ghost">
                      {s.label}
                    </button>
                  ))}
                </div>
              )}
              <div class="gf-answer">
                <textarea name="answer" placeholder="type your answer · or click a suggestion above" />
                <div class="row">
                  <span class="hint">✓ autosaved · resume from this step anytime</span>
                  <button type="submit" class="btn primary" style="margin-left:auto">
                    answer ↵
                  </button>
                </div>
              </div>
            </form>
          )}
        </div>

        <CapturePanel capture={props.capture} />
      </div>
    </>
  );
}
