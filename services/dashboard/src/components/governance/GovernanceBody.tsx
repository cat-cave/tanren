/**
 * Project audit-posture settings. Values shown here are always a validated
 * canonical governance response; absent data renders unavailable, never a fake
 * default. The form posts through the dashboard BFF to the org-admin PUT.
 */

import type { GovernanceView } from "../../api/governance.js";
import type { ProjectSummary } from "../../api/types.js";
import { CsrfField } from "../shell/CsrfField.js";
import { GOVERNANCE_SCREEN_CSS } from "./styles.js";

export type GovernanceFlash = { kind: "ok" | "err"; message: string } | undefined;

export interface GovernanceBodyProps {
  projects: ProjectSummary[];
  project: ProjectSummary | undefined;
  governance: GovernanceView | undefined;
  readFailure: "unavailable" | "malformed" | undefined;
  flash: GovernanceFlash;
  csrfToken: string | undefined;
}

const BLOCK_LEVELS = ["P0", "P1", "P2", "P3"] as const;
const RESIDUAL_HANDLING = ["fix-if-idle", "route-to-dag"] as const;

function ProjectPicker(props: Pick<GovernanceBodyProps, "projects" | "project">) {
  return (
    <section class="panel">
      <div class="panel-body">
        <form class="project-picker" method="get" action="/settings/governance">
          <div class="field grow">
            <label for="governance-project">project</label>
            <select id="governance-project" name="projectId" disabled={props.projects.length === 0}>
              {props.projects.length === 0 ? <option value="">no visible projects</option> : null}
              {props.projects.map((project) => (
                <option value={project.projectId} selected={project.projectId === props.project?.projectId}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>
          <button class="btn" type="submit" disabled={props.projects.length === 0}>
            load project
          </button>
        </form>
      </div>
    </section>
  );
}

function CurrentPosture(props: { governance: GovernanceView }) {
  const posture = props.governance.auditPosture;
  return (
    <div class="posture-current" data-current-audit-posture>
      <div class="current-card">
        <span class="key">blockReviewAt</span>
        <span class="value" data-current-block-review-at={posture.blockReviewAt}>
          {posture.blockReviewAt}
        </span>
      </div>
      <div class="current-card">
        <span class="key">p2p3Handling</span>
        <span class="value" data-current-p2p3-handling={posture.p2p3Handling}>
          {posture.p2p3Handling}
        </span>
      </div>
      <div class="current-card">
        <span class="key">autonomousRemediation</span>
        <span class="value" data-current-autonomous-remediation={String(posture.autonomousRemediation)}>
          {posture.autonomousRemediation ? "enabled" : "disabled"}
        </span>
      </div>
    </div>
  );
}

function PostureForm(props: { projectId: string; governance: GovernanceView; csrfToken: string | undefined }) {
  const posture = props.governance.auditPosture;
  return (
    <form class="posture-form" method="post" action="/settings/governance">
      <CsrfField token={props.csrfToken} />
      <input type="hidden" name="projectId" value={props.projectId} />
      <div class="form-grid">
        <div class="field">
          <label for="blockReviewAt">block review at</label>
          <select id="blockReviewAt" name="blockReviewAt">
            {BLOCK_LEVELS.map((severity) => (
              <option value={severity} selected={severity === posture.blockReviewAt}>
                {severity}
              </option>
            ))}
          </select>
        </div>
        <div class="field">
          <label for="p2p3Handling">P2/P3 residual handling</label>
          <select id="p2p3Handling" name="p2p3Handling">
            {RESIDUAL_HANDLING.map((handling) => (
              <option value={handling} selected={handling === posture.p2p3Handling}>
                {handling}
              </option>
            ))}
          </select>
        </div>
      </div>
      <label class="check-row" for="autonomousRemediation">
        <input
          id="autonomousRemediation"
          name="autonomousRemediation"
          type="checkbox"
          value="true"
          checked={posture.autonomousRemediation}
        />
        <span class="copy">
          <span>autonomous remediation</span>
          <span class="detail">
            Blocking findings become governed remediation DAG work instead of parking for a human.
          </span>
        </span>
      </label>
      <div class="actions">
        <span class="note">Writes require org-admin authority and use the canonical governance PUT.</span>
        <button class="btn primary" type="submit">
          save audit posture
        </button>
      </div>
    </form>
  );
}

export function GovernanceBody(props: GovernanceBodyProps) {
  return (
    <>
      <style data-screen="governance" dangerouslySetInnerHTML={{ __html: GOVERNANCE_SCREEN_CSS }} />
      <div class="page-head">
        <div>
          <div class="eyebrow">▮ project · settings · governance</div>
          <div class="page-title">audit posture</div>
          <div class="sub">the governed audit-to-review and remediation decision</div>
        </div>
      </div>
      <div class="page-body">
        <div class="governance-screen">
          <ProjectPicker projects={props.projects} project={props.project} />
          {props.flash === undefined ? null : (
            <div class={`flash ${props.flash.kind}`} role="status" data-governance-flash={props.flash.kind}>
              {props.flash.message}
            </div>
          )}
          {props.project === undefined ? (
            <section class="panel">
              <div class="panel-body empty">
                {props.projects.length === 0
                  ? "No project visible yet. Onboard one before configuring audit posture."
                  : "The requested project is not visible. Choose a project above."}
              </div>
            </section>
          ) : props.readFailure === "malformed" ? (
            <section class="panel" data-governance-malformed>
              <div class="panel-body empty">
                Governance response malformed — no values or defaults were displayed. Verify orchestrator/dashboard
                versions, then retry the canonical read.
              </div>
            </section>
          ) : props.readFailure === "unavailable" || props.governance === undefined ? (
            <section class="panel" data-governance-unavailable>
              <div class="panel-body empty">
                Governance unavailable — the canonical orchestrator read failed. No defaults were substituted.
              </div>
            </section>
          ) : (
            <section class="panel" data-governance-panel>
              <div class="panel-head">
                <h2>{props.project.name} · current enforced posture</h2>
                <span class="meta">GET /orgs/:orgId/projects/:projectId/governance</span>
              </div>
              <div class="panel-body">
                <CurrentPosture governance={props.governance} />
                <div class="context-line">
                  reviewPolicy={props.governance.reviewPolicy} · mergeIntegration={props.governance.mergeIntegration} ·
                  governancePosture={props.governance.governancePosture}
                </div>
                <PostureForm
                  projectId={props.project.projectId}
                  governance={props.governance}
                  csrfToken={props.csrfToken}
                />
              </div>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
