/**
 * the greenfield (`/onboarding/new`) flow body: the 3-step shell
 * (interview → derived dag → arrival) over the shared `OnbStyles` plus the
 * greenfield-specific `GreenfieldStyles`. Pure dispatch over the active step;
 * each step body owns its own render + forms. The journey strip mirrors the
 * hi-fi `view-onboard-new` step rail.
 */

import type { ProjectDag } from "../../../api/projectDag.js";
import type { InterviewCapture, InterviewSuggestion } from "../../../api/onboardingNewTypes.js";
import { OnbStyles } from "../styles.js";
import { ArrivalStep } from "./ArrivalStep.js";
import { DerivedDagStep } from "./DerivedDagStep.js";
import { GreenfieldStyles } from "./greenfieldStyles.js";
import { InterviewStep } from "./InterviewStep.js";

const STEPS: Array<{ l: string; e: string }> = [
  { l: "say what", e: "we're building" },
  { l: "seed the", e: "spec dag" },
  { l: "light the", e: "fire" },
];

export interface GreenfieldBodyProps {
  step: 1 | 2 | 3;
  // Step 1 (interview).
  interview?: {
    round: number;
    totalRounds: number;
    say: string;
    suggestions: InterviewSuggestion[];
    priorAnswer: string;
    capture: InterviewCapture;
    complete: boolean;
  };
  // Steps 2 + 3 (post-derive): the live derived graph + project.
  derived?: {
    projectId: string;
    projectName: string;
    dag: ProjectDag;
  };
  error?: string;
  /** Session CSRF for pure HTML form posts (cookie-authenticated writes). */
  csrfToken?: string;
}

function Journey(props: { step: number }) {
  return (
    <div class="journey" data-greenfield-journey>
      {STEPS.map((s, i) => {
        const n = i + 1;
        const cls = n < props.step ? "done" : n === props.step ? "live" : "";
        return (
          <>
            {i > 0 && <span class="j-arrow">→</span>}
            <span class={`j-step ${cls}`}>
              <span class="num">{n}</span>
              {s.l} {s.e}
            </span>
          </>
        );
      })}
      <span style="margin-left:auto;font-family:var(--font-mono);font-size:10px;color:var(--fg-3)">
        new project · greenfield
      </span>
    </div>
  );
}

export function GreenfieldBody(props: GreenfieldBodyProps) {
  return (
    <>
      <OnbStyles />
      <GreenfieldStyles />
      <div class="onb" data-screen="onboarding-new">
        <Journey step={props.step} />
        {props.error !== undefined && (
          <div class="gf-card" style="border-color:var(--status-warn)">
            <div class="body" style="color:var(--status-warn)">
              {props.error}
            </div>
          </div>
        )}
        {props.step === 1 && props.interview !== undefined && (
          <InterviewStep
            round={props.interview.round}
            totalRounds={props.interview.totalRounds}
            say={props.interview.say}
            suggestions={props.interview.suggestions}
            priorAnswer={props.interview.priorAnswer}
            capture={props.interview.capture}
            complete={props.interview.complete}
            csrfToken={props.csrfToken}
          />
        )}
        {props.step === 2 && props.derived !== undefined && (
          <DerivedDagStep
            projectId={props.derived.projectId}
            projectName={props.derived.projectName}
            dag={props.derived.dag}
            csrfToken={props.csrfToken}
          />
        )}
        {props.step === 3 && props.derived !== undefined && (
          <ArrivalStep
            projectId={props.derived.projectId}
            projectName={props.derived.projectName}
            specCount={props.derived.dag.counts.total}
            readyCount={readyLeafCount(props.derived.dag)}
          />
        )}
      </div>
    </>
  );
}

// A leaf spec is "ready" when nothing it depends on is unmet and it has no
// downstream dependents pending it — approximated here as queued nodes not on
// the critical path (mirrors the hi-fi "1 ready" arrival count).
function readyLeafCount(dag: ProjectDag): number {
  const ready = dag.nodes.filter((n) => n.status === "queued" && !n.onCriticalPath).length;
  return Math.max(1, ready);
}
