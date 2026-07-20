import type { MergeQueueEagerBeamsResponse } from "../../api/mergeQueueEagerBeams.js";

export function EagerBeamPanel(props: { projection: MergeQueueEagerBeamsResponse | undefined }) {
  const beams = props.projection?.beams;
  return (
    <section class="panel">
      <div class="panel-pad">
        <div class="mini-eyebrow">
          eager speculative beams <span class="window-tag">(build-only · never authority)</span>
        </div>
        {beams === undefined ? (
          <div class="empty">EAGER beam evidence is unavailable; no speculative result is treated as usable.</div>
        ) : beams.length === 0 ? (
          <div class="empty">No dependent frontier with published heads is currently in the advisory beam.</div>
        ) : (
          <div class="mq-list">
            {beams.map((beam) => (
              <div class="mq-list-row">
                <b>
                  #{beam.rank} · {beam.state}
                </b>
                <span>frontier {beam.frontierSpecId}</span>
                <span>base {beam.baseSha ?? "unavailable"}</span>
                <span>members {beam.members?.map((member) => member.headSha).join(", ") ?? "unavailable"}</span>
                <span>
                  node {beam.integrationNodeId ?? "none"} · evidence {beam.evidenceState}
                </span>
                {beam.staleReason === null ? null : <span>reason {beam.staleReason}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
