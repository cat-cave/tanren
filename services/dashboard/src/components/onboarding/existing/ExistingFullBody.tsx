/**
 * the brownfield (`/onboarding/existing`) FULL track body: the 5-step
 * shell over the shared `OnbStyles` plus the brownfield-specific
 * `ExistingStyles`. Pure dispatch over the active step:
 *   1 link repo        — the `ExistingProjectBody` (reused verbatim)
 *   2 recon            — read-only Answerer chapters + gaps
 *   3 config-injection — 6-file preview + per-file exclude → open PR
 *   4 spec dag + seed  — recon gaps + GitHub issues → seed specs
 *   5 governance       — strict/open/audit-only posture picker
 *
 * Steps 2-5 carry the recon report forward on hidden form fields (transient —
 * no session table), mirroring the greenfield capture model. The journey strip
 * mirrors the hi-fi `view-onboard-existing` step rail.
 */

import type {
  ConfigInjectionResult,
  GovernancePosture,
  GovernanceResult,
  ReconReport,
  ReconResult,
  SeedDagResult,
} from "../../../api/existingBrownfieldTypes.js";
import type { BrownfieldDetectedFile } from "../../../api/types.js";
import { ExistingProjectBody } from "../ExistingProjectBody.js";
import { OnbStyles } from "../styles.js";
import { ConfigInjectionStep } from "./ConfigInjectionStep.js";
import { ExistingStyles } from "./existingStyles.js";
import { GovernanceStep } from "./GovernanceStep.js";
import { ReconStep } from "./ReconStep.js";
import { SeedDagStep } from "./SeedDagStep.js";

const STEPS: Array<{ l: string; e: string }> = [
  { l: "link an", e: "existing repo" },
  { l: "confirm what the", e: "agent found" },
  { l: "merge the", e: "integration pr" },
  { l: "seed the", e: "dag from reality" },
  { l: "decide", e: "the posture" },
];

export const EXISTING_FULL_BASE = "/onboarding/existing";

export interface ExistingFullBodyProps {
  step: 1 | 2 | 3 | 4 | 5;
  orgLogin: string;
  githubAppUrl: string;
  // Step-1 (link) state — delegated to the minimal body.
  link?: {
    linked?: { repoUrl: string; files: BrownfieldDetectedFile[]; projectId: string };
    error?: string;
  };
  // Steps 2-5 carry the linked project + repo + the recon report forward.
  projectId?: string;
  repoUrl?: string;
  recon?: ReconResult;
  report?: ReconReport;
  posture?: GovernancePosture;
  configInjection?: ConfigInjectionResult;
  configInjectionError?: string;
  seeded?: SeedDagResult;
  seedError?: string;
  governance?: GovernanceResult;
  /** Session CSRF for pure HTML form posts (cookie-authenticated writes). */
  csrfToken?: string;
}

function Journey(props: { step: number }) {
  return (
    <div class="ex-journey" data-existing-journey>
      {STEPS.map((s, i) => {
        const n = i + 1;
        const cls = n < props.step ? "done" : n === props.step ? "live" : "";
        return (
          <>
            {i > 0 && <span class="j-arrow">→</span>}
            <span class={`j-step ${cls}`}>
              <span class="num">{n < props.step ? "✓" : n}</span>
              {s.l} {s.e}
            </span>
          </>
        );
      })}
      <span style="margin-left:auto;font-family:var(--font-mono);font-size:10px;color:var(--fg-3)">
        existing project · brownfield
      </span>
    </div>
  );
}

export function ExistingFullBody(props: ExistingFullBodyProps) {
  return (
    <>
      <OnbStyles />
      <ExistingStyles />
      <div class="onb" data-screen="onboarding-existing-full">
        <Journey step={props.step} />
        {props.step === 1 ? (
          <ExistingProjectBody
            orgLogin={props.orgLogin}
            repos={[]}
            githubAppUrl={props.githubAppUrl}
            error={props.link?.error}
            linked={props.link?.linked}
            csrfToken={props.csrfToken}
          />
        ) : null}
        {props.step === 2 && props.recon !== undefined && props.repoUrl !== undefined ? (
          <ReconStep
            repoUrl={props.repoUrl}
            result={props.recon}
            baseAction={EXISTING_FULL_BASE}
            projectId={props.projectId}
            csrfToken={props.csrfToken}
          />
        ) : null}
        {props.step === 3 && props.report !== undefined && props.repoUrl !== undefined ? (
          <ConfigInjectionStep
            repoUrl={props.repoUrl}
            report={props.report}
            posture={props.posture ?? "strict"}
            baseAction={EXISTING_FULL_BASE}
            projectId={props.projectId}
            opened={props.configInjection}
            error={props.configInjectionError}
            csrfToken={props.csrfToken}
          />
        ) : null}
        {props.step === 4 && props.report !== undefined && props.repoUrl !== undefined ? (
          <SeedDagStep
            repoUrl={props.repoUrl}
            report={props.report}
            baseAction={EXISTING_FULL_BASE}
            projectId={props.projectId}
            seeded={props.seeded}
            error={props.seedError}
            csrfToken={props.csrfToken}
          />
        ) : null}
        {props.step === 5 && props.projectId !== undefined && props.repoUrl !== undefined ? (
          <GovernanceStep
            projectId={props.projectId}
            repoUrl={props.repoUrl}
            baseAction={EXISTING_FULL_BASE}
            current={props.posture ?? "strict"}
            saved={props.governance}
            csrfToken={props.csrfToken}
          />
        ) : null}
      </div>
    </>
  );
}
