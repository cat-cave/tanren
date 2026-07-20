import type { MergeQueueEvidenceContractResponse } from "../../api/mergeQueueEvidenceContracts.js";

/** Read-only visibility for the most recently sealed merge-train node's F2 evidence. */
export function EvidenceContractPanel(props: { projection: MergeQueueEvidenceContractResponse | undefined }) {
  const evidence = props.projection;
  return (
    <section class="panel">
      <div class="panel-pad">
        <div class="mini-eyebrow">fragment evidence contract · reported</div>
        {evidence === undefined ? (
          <div class="empty">No evidence-contract observation is available for the latest merge-train node.</div>
        ) : evidence.resolutionStatus === "selected" && evidence.contract !== null ? (
          <div class="note">
            <b>selected declarative evidence.</b> JUnit <code>{evidence.contract.junitReportPath}</code> · selector{" "}
            <code>{evidence.contract.testSelector.path}</code> · behavior{" "}
            <code>{evidence.contract.behaviorManifest.path}</code>
            <br />
            artifact <code>{evidence.contract.contentDigest}</code> · proof unit{" "}
            <code>{evidence.proofUnit?.id ?? "—"}</code>
          </div>
        ) : (
          <div class="note">
            <b>full native pre-merge gate retained.</b>{" "}
            {evidence.fallback ?? "The frozen contract could not be observed."}
            {evidence.proofUnit === null
              ? " No reusable selective proof was recorded."
              : ` Proof unit: ${evidence.proofUnit.id}.`}
          </div>
        )}
      </div>
    </section>
  );
}
