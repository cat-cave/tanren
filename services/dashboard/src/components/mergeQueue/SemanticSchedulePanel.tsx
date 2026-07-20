import type { MergeQueueScheduleResponse } from "../../api/mergeQueueSchedule.js";

/** Current semantic schedule explanation. Read-only: no UI action can claim or land work. */
export function SemanticSchedulePanel(props: { projection: MergeQueueScheduleResponse | undefined }) {
  const schedule = props.projection?.schedule;
  return (
    <section class="panel">
      <div class="panel-pad">
        <div class="mini-eyebrow">
          semantic integration schedule <span class="window-tag">(read-only · authority unchanged)</span>
        </div>
        {schedule === undefined ? (
          <div class="empty">
            Semantic scheduling facts are unavailable; no absent fact is presented as an independent batch.
          </div>
        ) : schedule.partitions.length === 0 ? (
          <div class="empty">No queued semantic partition is currently visible.</div>
        ) : (
          <div class="mq-list">
            <div class="mq-list-row">
              <b>selected cap {schedule.selectedCap}</b>
              <span>proposal {schedule.selectedRunIds.join(", ") || "held"}</span>
              <span>
                leases{" "}
                {schedule.activeLeases.map((lease) => `${lease.partitionId}@${lease.leaseEpoch}`).join(", ") || "none"}
              </span>
            </div>
            {schedule.partitions.map((partition) => (
              <div class="mq-list-row">
                <b>{partition.specId}</b>
                <span>{partition.classes.join(" + ")}</span>
                <span>{partition.conservative ? "serial barrier" : "scoped"}</span>
                <span>{partition.fingerprint}</span>
              </div>
            ))}
            {schedule.blockers.length === 0 ? null : <div class="note">blockers: {schedule.blockers.join(", ")}</div>}
            <div class="note">{schedule.conservativeInput}</div>
          </div>
        )}
      </div>
    </section>
  );
}
