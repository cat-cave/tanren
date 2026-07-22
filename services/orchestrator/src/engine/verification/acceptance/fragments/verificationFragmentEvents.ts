// rv-3 — the family EVENT binding: kernel lifecycle → the frozen SP-8
// `behavior.fragment.*` events (runtime vocabulary) + the EventStore sink.
//
// The event names + strict payloads were FROZEN by the runtime-verification spine
// (`events/schemas/runtimeVocabulary.ts` + `sensitivityRules.runtimeVocabulary.ts`);
// rv-3 only MAPS lifecycle points onto them. No new event is minted. Only the two
// lifecycle points whose frozen payloads this family can truthfully fill are emitted:
// `started` → authoring_started and batch-committed `succeeded` → validated. Attempts
// and failures have no registered vocabulary and are deliberately not invented.

import type { EventStore } from "../../../eventStore.js";
import type { AuthoringEventFactory, AuthoringEvents, AuthoringEventSink } from "../../../contracts/authoringKernel.js";
import {
  parseVerificationFragmentAuthoringContext,
  verificationFragmentId,
  type ValidatedVerificationFragment,
  type VerificationFragmentDraftV1,
  type VerificationFragmentKind,
  type VerificationFragmentSpecV1,
} from "./verificationFragment.js";

const ID_MAX = 256;

interface EventEnvelope {
  readonly orgId: string;
  readonly projectId: string;
  readonly runId?: string;
  readonly specId?: string;
}

/** The family event union — a frozen name + payload, or the no-op skip. */
export type VerificationFragmentAuthoringEvent =
  | {
      readonly kind: "emit";
      readonly eventType: "behavior.fragment.authoring_started";
      readonly envelope: EventEnvelope;
      readonly payload: {
        readonly behaviorRevisionId: string;
        readonly capability: VerificationFragmentKind;
        readonly fragmentId: string;
      };
    }
  | {
      readonly kind: "emit";
      readonly eventType: "behavior.fragment.validated";
      readonly envelope: EventEnvelope;
      readonly payload: {
        readonly behaviorRevisionId: string;
        readonly capability: VerificationFragmentKind;
        readonly fragmentId: string;
        readonly fragmentVersion: string;
        /** Present only when F2 measured this control for this fragment. */
        readonly negativeControlPassed?: boolean;
      };
    }
  | { readonly kind: "none" };

const NONE: VerificationFragmentAuthoringEvent = { kind: "none" };

/** Maps a kernel lifecycle point to the family's frozen SP-8 event (or a no-op). */
export function createVerificationFragmentAuthoringEventFactory(): AuthoringEventFactory<
  VerificationFragmentSpecV1,
  VerificationFragmentDraftV1,
  ValidatedVerificationFragment,
  VerificationFragmentAuthoringEvent
> {
  return {
    build(input): VerificationFragmentAuthoringEvent {
      if (input.lifecycle.point !== "started" && input.lifecycle.point !== "succeeded") return NONE;
      const context = parseVerificationFragmentAuthoringContext(input.request.context);
      const envelope: EventEnvelope = {
        orgId: context.orgId,
        projectId: context.projectId,
        ...(context.runId === undefined ? {} : { runId: context.runId }),
        ...(context.specId === undefined ? {} : { specId: context.specId }),
      };
      if (input.lifecycle.point === "succeeded") {
        const validated = input.lifecycle.validated;
        return {
          kind: "emit",
          eventType: "behavior.fragment.validated",
          envelope,
          payload: {
            behaviorRevisionId: truncateId(context.behaviorRevisionId),
            capability: validated.fragmentKind,
            fragmentId: truncateId(validated.fragmentId),
            fragmentVersion: validated.version,
            // F2 currently reports only valid/rejected, not a separate measured
            // negative-control signal. Do not infer one from acceptance.
          },
        };
      }
      const spec = input.lifecycle.spec;
      return {
        kind: "emit",
        eventType: "behavior.fragment.authoring_started",
        envelope,
        payload: {
          behaviorRevisionId: truncateId(context.behaviorRevisionId),
          capability: spec.fragmentKind,
          fragmentId: truncateId(verificationFragmentId(spec.fragmentKind, spec.capabilityKey)),
        },
      };
    },
  };
}

/** The EventStore sink — appends the frozen event, stamping the envelope's scope. */
export function createVerificationFragmentAuthoringEventSink(
  eventStore: EventStore,
): AuthoringEventSink<VerificationFragmentAuthoringEvent> {
  return {
    async emit(event): Promise<void> {
      if (event.kind === "none") return;
      await eventStore.append({
        eventType: event.eventType,
        payload: event.payload,
        orgId: event.envelope.orgId,
        projectId: event.envelope.projectId,
        ...(event.envelope.runId === undefined ? {} : { runId: event.envelope.runId }),
        ...(event.envelope.specId === undefined ? {} : { specId: event.envelope.specId }),
      });
    },
  };
}

/** Assemble the kernel `AuthoringEvents` (factory + sink) for a live EventStore. */
export function createVerificationFragmentAuthoringEvents(
  eventStore: EventStore,
): AuthoringEvents<
  VerificationFragmentSpecV1,
  VerificationFragmentDraftV1,
  ValidatedVerificationFragment,
  VerificationFragmentAuthoringEvent
> {
  return {
    factory: createVerificationFragmentAuthoringEventFactory(),
    sink: createVerificationFragmentAuthoringEventSink(eventStore),
  };
}

function truncateId(value: string): string {
  const trimmed = value.length <= ID_MAX ? value : value.slice(0, ID_MAX);
  return trimmed.length === 0 ? "<empty>" : trimmed;
}
