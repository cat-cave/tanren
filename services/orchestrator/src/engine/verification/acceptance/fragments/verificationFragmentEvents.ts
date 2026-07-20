// rv-3 — the family EVENT binding: kernel lifecycle → the frozen SP-8
// `behavior.fragment.*` events (runtime vocabulary) + the EventStore sink.
//
// The event names + strict payloads were FROZEN by the runtime-verification spine
// (`events/schemas/runtimeVocabulary.ts` + `sensitivityRules.runtimeVocabulary.ts`);
// rv-3 only MAPS lifecycle points onto them. No new event is minted. Only the two
// lifecycle points whose payloads rv-3 can fill TRUTHFULLY are emitted — `started`
// → `behavior.fragment.authoring_started`. The per-attempt and terminal points carry
// no frozen event (a `behavior.fragment.failed` / `.attempt` event does not exist in
// the vocabulary and a `.validated` payload requires a `negativeControlPassed` signal
// rv-3 does not compute — that is ds-4/rv-13 territory), so they map to a NO-OP the
// sink skips. The durable proof is the persisted registry row, never the event.

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
      if (input.lifecycle.point !== "started") return NONE;
      const context = parseVerificationFragmentAuthoringContext(input.request.context);
      const spec = input.lifecycle.spec;
      const envelope: EventEnvelope = {
        orgId: context.orgId,
        projectId: context.projectId,
        ...(context.runId === undefined ? {} : { runId: context.runId }),
        ...(context.specId === undefined ? {} : { specId: context.specId }),
      };
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
