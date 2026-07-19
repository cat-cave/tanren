// ds-3 (F2D) — the family EVENT binding: kernel lifecycle → the frozen SP-8
// `designFragment.authoring.*` events (ds-0 vocabulary) + the EventStore sink.
//
// The four event names + strict payloads were FROZEN by ds-0
// (`designSystemVocabulary.ts` / `sensitivityRules.designSystem.ts` /
// `eventDefaultSeverity.ts` / the generated seed) — ds-3 only MAPS lifecycle points
// onto them and appends. No new event is minted here. The sink is best-effort: the
// kernel already swallows a sink throw, and the EventStore stamps org/run/project
// from the envelope, so the payloads carry only stable ids/digests/counts (all
// `public` per the frozen sensitivity rules).

import type { z } from "zod";
import type { EventStore } from "../../../eventStore.js";
import {
  DesignFragmentAuthoringAttemptPayload,
  DesignFragmentAuthoringFailedPayload,
  DesignFragmentAuthoringStartedPayload,
  DesignFragmentAuthoringSucceededPayload,
} from "../../../events/schemas/designSystemVocabulary.js";
import type {
  AuthoringEventFactory,
  AuthoringEvents,
  AuthoringEventSink,
  AuthoringLifecyclePoint,
} from "../../../contracts/authoringKernel.js";
import type { DesignFragmentSpecV1 } from "../designArtifactSchemas.js";
import { parseDesignFragmentAuthoringContext, type DesignFragmentAuthoringContext } from "./designFragmentContext.js";
import type { DesignFragmentDraftV1, ValidatedDesignFragment } from "./designFragmentDraft.js";

const ID_MAX = 256;
const REASON_MAX = 200;

interface DesignFragmentEventEnvelope {
  readonly orgId: string;
  readonly runId?: string;
  readonly projectId?: string;
  readonly specId?: string;
}

/** The family event union — a frozen name + its strict payload + the append envelope. */
export type DesignFragmentAuthoringEvent =
  | {
      readonly eventType: "designFragment.authoring.started";
      readonly envelope: DesignFragmentEventEnvelope;
      readonly payload: z.infer<typeof DesignFragmentAuthoringStartedPayload>;
    }
  | {
      readonly eventType: "designFragment.authoring.attempt";
      readonly envelope: DesignFragmentEventEnvelope;
      readonly payload: z.infer<typeof DesignFragmentAuthoringAttemptPayload>;
    }
  | {
      readonly eventType: "designFragment.authoring.succeeded";
      readonly envelope: DesignFragmentEventEnvelope;
      readonly payload: z.infer<typeof DesignFragmentAuthoringSucceededPayload>;
    }
  | {
      readonly eventType: "designFragment.authoring.failed";
      readonly envelope: DesignFragmentEventEnvelope;
      readonly payload: z.infer<typeof DesignFragmentAuthoringFailedPayload>;
    };

/** Maps a kernel lifecycle point to the family's frozen SP-8 event draft. */
export function buildDesignFragmentAuthoringEvent(input: {
  readonly lifecycle: AuthoringLifecyclePoint<DesignFragmentSpecV1, DesignFragmentDraftV1, ValidatedDesignFragment>;
  readonly context: DesignFragmentAuthoringContext;
}): DesignFragmentAuthoringEvent {
  const envelope = envelopeFrom(input.context);
  const lifecycle = input.lifecycle;
  const runId = lifecycle.unitId;

  switch (lifecycle.point) {
    case "started":
      return {
        eventType: "designFragment.authoring.started",
        envelope,
        payload: DesignFragmentAuthoringStartedPayload.parse({
          fragmentAuthoringRunId: runId,
          fragmentKind: lifecycle.spec.kind,
          fragmentLabel: lifecycle.spec.label,
        }),
      };
    case "attempt":
      return {
        eventType: "designFragment.authoring.attempt",
        envelope,
        payload: DesignFragmentAuthoringAttemptPayload.parse({
          fragmentAuthoringRunId: runId,
          attempt: lifecycle.attempt,
          workspaceChangeId: truncateId(lifecycle.canonicalSignature),
          rejectionSignature: lifecycle.rejection === "" ? null : truncateId(lifecycle.rejection),
        }),
      };
    case "succeeded":
      return {
        eventType: "designFragment.authoring.succeeded",
        envelope,
        payload: DesignFragmentAuthoringSucceededPayload.parse({
          fragmentAuthoringRunId: runId,
          fragmentReleaseId: lifecycle.validated.fragmentReleaseId,
          fragmentDigest: lifecycle.validated.fragmentDigest,
          fragmentVersion: lifecycle.validated.fragmentVersion,
        }),
      };
    case "failed":
      return {
        eventType: "designFragment.authoring.failed",
        envelope,
        payload: DesignFragmentAuthoringFailedPayload.parse({
          fragmentAuthoringRunId: runId,
          attempts: lifecycle.attempts,
          reason: truncate(lifecycle.reason, REASON_MAX),
        }),
      };
    default: {
      // Exhaustive — the kernel lifecycle union has no other points.
      const exhaustive: never = lifecycle;
      throw new Error(`unreachable design fragment lifecycle: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** The kernel-facing factory: parses the org scope from context, then maps. */
export function createDesignFragmentAuthoringEventFactory(): AuthoringEventFactory<
  DesignFragmentSpecV1,
  DesignFragmentDraftV1,
  ValidatedDesignFragment,
  DesignFragmentAuthoringEvent
> {
  return {
    build(input): DesignFragmentAuthoringEvent {
      const context = parseDesignFragmentAuthoringContext(input.request.context);
      return buildDesignFragmentAuthoringEvent({ lifecycle: input.lifecycle, context });
    },
  };
}

/** The EventStore sink — appends the frozen event, stamping the envelope's scope. */
export function createDesignFragmentAuthoringEventSink(
  eventStore: EventStore,
): AuthoringEventSink<DesignFragmentAuthoringEvent> {
  return {
    async emit(event): Promise<void> {
      // Switch so TS correlates each frozen eventType with its payload type across
      // the generic `append<N>` boundary (the discriminated union cannot be passed
      // opaquely — N and the payload must be resolved per-arm).
      const scope = {
        orgId: event.envelope.orgId,
        ...(event.envelope.runId === undefined ? {} : { runId: event.envelope.runId }),
        ...(event.envelope.projectId === undefined ? {} : { projectId: event.envelope.projectId }),
        ...(event.envelope.specId === undefined ? {} : { specId: event.envelope.specId }),
      };
      switch (event.eventType) {
        case "designFragment.authoring.started":
          await eventStore.append({ eventType: event.eventType, payload: event.payload, ...scope });
          return;
        case "designFragment.authoring.attempt":
          await eventStore.append({ eventType: event.eventType, payload: event.payload, ...scope });
          return;
        case "designFragment.authoring.succeeded":
          await eventStore.append({ eventType: event.eventType, payload: event.payload, ...scope });
          return;
        case "designFragment.authoring.failed":
          await eventStore.append({ eventType: event.eventType, payload: event.payload, ...scope });
          break;
      }
    },
  };
}

/** Assemble the kernel `AuthoringEvents` (factory + sink) for a live EventStore. */
export function createDesignFragmentAuthoringEvents(
  eventStore: EventStore,
): AuthoringEvents<DesignFragmentSpecV1, DesignFragmentDraftV1, ValidatedDesignFragment, DesignFragmentAuthoringEvent> {
  return {
    factory: createDesignFragmentAuthoringEventFactory(),
    sink: createDesignFragmentAuthoringEventSink(eventStore),
  };
}

function envelopeFrom(context: DesignFragmentAuthoringContext): DesignFragmentEventEnvelope {
  return {
    orgId: context.orgId,
    ...(context.runId === undefined ? {} : { runId: context.runId }),
    ...(context.projectId === undefined ? {} : { projectId: context.projectId }),
    ...(context.specId === undefined ? {} : { specId: context.specId }),
  };
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

/** Truncate to a non-empty `Id` (min 1, max 256). */
function truncateId(value: string): string {
  const trimmed = value.length <= ID_MAX ? value : value.slice(0, ID_MAX);
  return trimmed.length === 0 ? "<empty>" : trimmed;
}
