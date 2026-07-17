export type EffectObservationClassification = "ok" | "missing" | "duplicate";

/** A redacted provider-side fact; raw bodies and cursors do not enter events. */
export interface EffectObservation {
  orgId: string;
  projectId: string;
  observationId: string;
  triggerIdHash?: string;
  observer: string;
  provider: string;
  providerObjectHash?: string;
  cursor?: string;
  occurrenceCount: number;
  latencyMs?: number;
  classification: EffectObservationClassification;
  createdAt: Date;
}

export interface ObserveSideEffectInput {
  orgId: string;
  projectId: string;
  observer: string;
  provider: string;
  triggerIdHash?: string;
  afterWatermark?: string;
}

export interface AdvanceSideEffectWatermarkInput {
  orgId: string;
  projectId: string;
  observer: string;
  watermark: string;
}

/** Type-only rv-8 port; the owning lane supplies implementations and conformance. */
export interface SideEffectObserverAdapter {
  observe(input: ObserveSideEffectInput): Promise<ReadonlyArray<EffectObservation>>;
  advanceWatermark(input: AdvanceSideEffectWatermarkInput): Promise<void>;
}
