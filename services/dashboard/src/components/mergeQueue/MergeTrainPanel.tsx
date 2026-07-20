import type { MergeTrainArtifactSummary, MergeTrainListResponse } from "../../api/mergeQueueTrain.js";

export interface MergeTrainPanelProps {
  /** mq-15 sealed-train projection (undefined when the read failed / no project). */
  readonly projection: MergeTrainListResponse | undefined;
  readonly orgId: string;
  readonly projectId: string;
}

const MERGE_TRAIN_CSS = `
.merge-queue-screen .mqt-list { display: flex; flex-direction: column; gap: 10px; }
.merge-queue-screen .mqt-train {
  border: 1px solid var(--line-1); border-radius: 8px; padding: 13px 14px;
  display: flex; flex-direction: column; gap: 10px;
}
.merge-queue-screen .mqt-head {
  display: grid; grid-template-columns: minmax(190px, .8fr) minmax(260px, 1.2fr); gap: 12px;
}
.merge-queue-screen .mqt-col { display: flex; flex-direction: column; gap: 4px; }
.merge-queue-screen .mqt-state {
  font: 700 11px var(--font-mono); letter-spacing: .05em; text-transform: uppercase; color: var(--ember-08);
}
.merge-queue-screen .mqt-summary { font: 11.5px var(--font-ui); color: var(--fg-2); line-height: 1.4; }
.merge-queue-screen .mqt-fact { font: 10.5px var(--font-mono); color: var(--fg-3); overflow-wrap: anywhere; }
.merge-queue-screen .mqt-fact b { color: var(--fg-1); }
.merge-queue-screen .mqt-terminal { display: flex; gap: 14px; flex-wrap: wrap; }
.merge-queue-screen .mqt-verified {
  font: 700 10px var(--font-mono); letter-spacing: .04em; text-transform: uppercase; color: var(--ember-08);
}
.merge-queue-screen .mqt-action {
  font: 10.5px var(--font-mono); color: var(--fg-2); text-decoration: underline; overflow-wrap: anywhere;
}
@media (max-width: 760px) { .merge-queue-screen .mqt-head { grid-template-columns: 1fr; } }
`;

function artifactHref(orgId: string, projectId: string, landGroupId: string): string {
  return (
    `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}` +
    `/merge-queue/land-groups/${encodeURIComponent(landGroupId)}/artifact`
  );
}

function TrainRow(props: { train: MergeTrainArtifactSummary; orgId: string; projectId: string }) {
  const { train } = props;
  // A sealed row only exists when the demo fully passed — so passed === behaviorCount.
  const demoGreen = train.demoBehaviorCount > 0 && train.demoPassed === train.demoBehaviorCount;
  return (
    <article class="mqt-train" data-land-group={train.landGroupId}>
      <div class="mqt-head">
        <div class="mqt-col">
          <span class="mqt-state">sealed delivery · verified</span>
          <span class="mqt-summary">
            One completed land group projected into a signed, content-addressed artifact over an authority decision,
            proof root, receipt, verified deploy, and proof-backed demo.
          </span>
          <span class="mqt-fact">
            land group · <b>{train.landGroupId}</b>
          </span>
          <span class="mqt-fact">
            integration node · <b>{train.integrationNodeId}</b>
          </span>
          <span class="mqt-fact">
            authority decision · <b>{train.authorityDecisionId}</b>
          </span>
        </div>
        <div class="mqt-col">
          <span class="mqt-fact">proof root · {train.proofRoot}</span>
          <span class="mqt-fact">receipt main sha · {train.receiptMainSha}</span>
          <span class="mqt-fact">bundle digest · {train.bundleDigest}</span>
          <span class="mqt-fact">content hash · {train.contentHash}</span>
          <span class="mqt-fact">sealed · {train.createdAt}</span>
        </div>
      </div>
      <div class="mqt-terminal">
        <span class="mqt-fact">
          deploy · <b>{train.deployDeploymentId}</b>
        </span>
        <span class="mqt-fact">
          demo ({train.demoSurfaceKind}) ·{" "}
          <b class={demoGreen ? "mqt-verified" : ""}>
            {train.demoPassed}/{train.demoBehaviorCount} behaviors passed
          </b>
        </span>
      </div>
      <a class="mqt-action" href={artifactHref(props.orgId, props.projectId, train.landGroupId)}>
        verify artifact · download signed manifest
      </a>
    </article>
  );
}

/** Visible mq-15 projection. Missing/unverifiable evidence is explicitly unknown, never green. */
export function MergeTrainPanel(props: MergeTrainPanelProps) {
  const artifacts = props.projection?.artifacts ?? [];
  return (
    <section class="panel" aria-label="merge train sealed delivery">
      <style data-component="merge-train" dangerouslySetInnerHTML={{ __html: MERGE_TRAIN_CSS }} />
      <div class="panel-pad">
        <div class="mini-eyebrow">merge train · mq-15 · sealed delivery artifacts</div>
        {props.projection === undefined ? (
          <div class="empty">
            Sealed merge-train evidence is unavailable — the orchestrator read failed. An unavailable read is never a
            delivery; the train state stays unknown, not green.
          </div>
        ) : artifacts.length === 0 ? (
          <div class="empty">
            No completed land group has sealed a delivery artifact yet. A train seals only after an exact authority
            decision, proof root, receipt, verified deploy, and proof-backed demo all agree; until then it is unknown,
            never green.
          </div>
        ) : (
          <div class="mqt-list">
            {artifacts.map((train) => (
              <TrainRow train={train} orgId={props.orgId} projectId={props.projectId} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
