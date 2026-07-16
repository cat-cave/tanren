import { z } from "zod";
import type {
  AuthoringEventFactory,
  AuthoringEventSink,
  AuthoringKernelInput,
  AuthoringLifecyclePoint,
} from "../authoringKernel.js";
import {
  INTEGRATION_AUTHOR_MISSION_NODE_ID,
  integrationAuthorEventPayloadDrafts,
  type IntegrationAuthorEventPayloadDraftByName,
  type ProspectiveIntegrationAuthorEventName,
} from "./integrationAuthorEventPayloads.js";

// PREP ONLY: this factory creates unregistered event drafts. It deliberately
// knows no EventStore, persistence adapter, proof store, gate, or land authority.
export const IntegrationAuthorEventFactoryContextDraft = z
  .object({
    missionNodeId: z.literal(INTEGRATION_AUTHOR_MISSION_NODE_ID),
    orgId: z.string().min(1).max(256),
    runId: z.string().min(1).max(256).optional(),
  })
  .strict();

export type IntegrationAuthorEventFactoryContextDraft = z.infer<typeof IntegrationAuthorEventFactoryContextDraft>;

export interface IntegrationAuthorEventEnvelopeDraft {
  readonly orgId: string;
  readonly runId?: string;
}

export type IntegrationAuthorEventDraft = {
  readonly [Name in ProspectiveIntegrationAuthorEventName]: {
    readonly eventType: Name;
    readonly envelope: IntegrationAuthorEventEnvelopeDraft;
    readonly payload: IntegrationAuthorEventPayloadDraftByName[Name];
  };
}[ProspectiveIntegrationAuthorEventName];

/** Map only facts handed over by SP-2; Spec, Draft, and Validated remain opaque. */
export function buildIntegrationAuthorEventDraft<Spec, Draft, Validated>(input: {
  readonly request: AuthoringKernelInput<Spec>;
  readonly lifecycle: AuthoringLifecyclePoint<Spec, Draft, Validated>;
}): IntegrationAuthorEventDraft {
  const context = IntegrationAuthorEventFactoryContextDraft.parse(input.request.context);
  const envelope = envelopeFrom(context);
  const lifecycle = input.lifecycle;
  const identity = {
    missionNodeId: context.missionNodeId,
    unitId: lifecycle.unitId,
  };

  switch (lifecycle.point) {
    case "started":
      return {
        eventType: "integration.author.started",
        envelope,
        payload: integrationAuthorEventPayloadDrafts["integration.author.started"].parse(identity),
      };
    case "attempt":
      return {
        eventType: "integration.author.attempt",
        envelope,
        payload: integrationAuthorEventPayloadDrafts["integration.author.attempt"].parse({
          ...identity,
          attempt: lifecycle.attempt,
          bodyPreview: lifecycle.bodyPreview,
          canonicalSignature: lifecycle.canonicalSignature,
          rejection: lifecycle.rejection,
          decision: lifecycle.decision,
        }),
      };
    case "succeeded":
      return {
        eventType: "integration.author.succeeded",
        envelope,
        payload: integrationAuthorEventPayloadDrafts["integration.author.succeeded"].parse({
          ...identity,
          attempts: lifecycle.attempts,
        }),
      };
    case "failed":
      return {
        eventType: "integration.author.failed",
        envelope,
        payload: integrationAuthorEventPayloadDrafts["integration.author.failed"].parse({
          ...identity,
          reason: lifecycle.reason,
          attempts: lifecycle.attempts,
        }),
      };
  }

  return assertNever(lifecycle);
}

/** Typed adapter for future family conformance tests; still not a producer. */
export function createIntegrationAuthorEventFactoryDraft<Spec, Draft, Validated>(): AuthoringEventFactory<
  Spec,
  Draft,
  Validated,
  IntegrationAuthorEventDraft
> {
  return { build: buildIntegrationAuthorEventDraft };
}

export const integrationAuthorEmitBoundaryDraft = {
  authority: "validated_non_retracted_family_row",
  transaction: "outside_family_persistence_transaction",
  delivery: "best_effort_observability",
  sinkFailure: "warn_and_continue",
  terminalCardinality: "exactly_one_per_unit",
} as const;

export type IntegrationAuthorTerminalEventName = Extract<
  ProspectiveIntegrationAuthorEventName,
  "integration.author.succeeded" | "integration.author.failed"
>;

export interface IntegrationAuthorTerminalStateDraft {
  readonly persisted: boolean;
  readonly batchVerdict: "not_run" | "passed" | "failed" | "skipped";
  readonly retracted: boolean;
}

/** Executable firing gate for the two terminal draft facts. */
export function integrationAuthorTerminalEmissionIsEligible(
  eventType: IntegrationAuthorTerminalEventName,
  state: IntegrationAuthorTerminalStateDraft,
): boolean {
  if (eventType === "integration.author.succeeded") {
    return state.persisted && state.batchVerdict === "passed" && !state.retracted;
  }

  const failedBeforePersistence = !state.persisted && state.batchVerdict === "not_run" && !state.retracted;
  const failedAfterBatchRetraction =
    state.persisted && state.retracted && (state.batchVerdict === "failed" || state.batchVerdict === "skipped");
  return failedBeforePersistence || failedAfterBatchRetraction;
}

/** Conformance helper: a complete plan has one terminal draft per requested unit. */
export function integrationAuthorTerminalsAreExactlyOnce(
  unitIds: readonly string[],
  drafts: readonly IntegrationAuthorEventDraft[],
): boolean {
  const expected = new Set(unitIds);
  if (expected.size !== unitIds.length) return false;

  const counts = new Map([...expected].map((unitId) => [unitId, 0]));
  for (const draft of drafts) {
    if (draft.eventType !== "integration.author.succeeded" && draft.eventType !== "integration.author.failed") {
      continue;
    }
    const previous = counts.get(draft.payload.unitId);
    if (previous === undefined || previous > 0) return false;
    counts.set(draft.payload.unitId, previous + 1);
  }
  return [...counts.values()].every((count) => count === 1);
}

export type IntegrationAuthorBestEffortEmitOutcome =
  | { readonly kind: "emitted" }
  | {
      readonly kind: "observability_gap";
      readonly errorMessage: string;
      readonly warningDelivered: boolean;
    };

/**
 * Reference throw-safe boundary for a future binding sink. An append failure is
 * visible to logging but never becomes row, proof, gate, or land authority.
 */
export async function emitIntegrationAuthorEventDraftBestEffort(input: {
  readonly sink: AuthoringEventSink<IntegrationAuthorEventDraft>;
  readonly event: IntegrationAuthorEventDraft;
  readonly warn: (message: string, fields: Readonly<Record<string, string>>) => void;
}): Promise<IntegrationAuthorBestEffortEmitOutcome> {
  try {
    await input.sink.emit(input.event);
    return { kind: "emitted" };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    let warningDelivered = true;
    try {
      input.warn("integration author event draft emit failed", {
        eventType: input.event.eventType,
        unitId: input.event.payload.unitId,
        error: errorMessage,
      });
    } catch {
      warningDelivered = false;
    }
    return { kind: "observability_gap", errorMessage, warningDelivered };
  }
}

function envelopeFrom(context: IntegrationAuthorEventFactoryContextDraft): IntegrationAuthorEventEnvelopeDraft {
  if (context.runId === undefined) return { orgId: context.orgId };
  return { orgId: context.orgId, runId: context.runId };
}

function assertNever(value: never): never {
  throw new Error(`unreachable integration author lifecycle: ${String(value)}`);
}
