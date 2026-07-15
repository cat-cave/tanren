import type { EventStore } from "../eventStore.js";
import type { EventPayload } from "../events/index.js";
import type { AffectedSelectionV1 } from "./affectedSelection.js";

export interface AffectedSelectionFactContext {
  readonly runId?: string;
  readonly specId?: string;
}

/**
 * Durable append-only fact seam for an affected selection. Tests inject a
 * recorder and prove the HTTP response is withheld when persistence fails.
 */
export interface AffectedSelectionFactWriter {
  record(selection: AffectedSelectionV1, context: AffectedSelectionFactContext): Promise<void>;
}

type SelectionPayload = EventPayload<"behavior.coverage.selection_analyzed">;

function eventPayload(selection: AffectedSelectionV1): SelectionPayload {
  return {
    version: selection.version,
    analysisId: selection.analysisId,
    mode: selection.mode,
    changedTargets: selection.changedTargets.map((target) => ({ ...target })),
    unknownTargets: selection.unknownTargets.map((target) => ({ ...target })),
    selected: selection.selected.map((behavior) => ({
      behaviorRevisionId: behavior.behaviorRevisionId,
      reasons: behavior.reasons.map((reason) => {
        switch (reason.kind) {
          case "direct_edge":
            return { ...reason, target: { ...reason.target } };
          case "transitive_dependency":
          case "dangling_dependency":
            return { ...reason };
          case "unknown_target":
            return { ...reason, target: { ...reason.target } };
          case "uncovered_behavior":
          case "no_changed_targets":
            return { kind: reason.kind };
        }
        throw new Error("unreachable affected-selection reason");
      }),
    })),
    excluded: selection.excluded.map((behavior) => ({
      behaviorRevisionId: behavior.behaviorRevisionId,
      reason: behavior.reason,
      inspectedEdgeIds: [...behavior.inspectedEdgeIds],
    })),
  };
}

/** Canonical production adapter: the event store is the only selection-fact writer. */
export class EventAffectedSelectionFactWriter implements AffectedSelectionFactWriter {
  constructor(private readonly events: EventStore) {}

  async record(selection: AffectedSelectionV1, context: AffectedSelectionFactContext): Promise<void> {
    await this.events.append({
      orgId: selection.orgId,
      projectId: selection.projectId,
      ...(context.runId === undefined ? {} : { runId: context.runId }),
      ...(context.specId === undefined ? {} : { specId: context.specId }),
      eventType: "behavior.coverage.selection_analyzed",
      payload: eventPayload(selection),
    });
  }
}
