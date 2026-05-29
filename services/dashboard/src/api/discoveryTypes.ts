/**
 * P3-0014 spec-discovery client types — the dashboard-side mirror of the
 * orchestrator's `engine/forge/discovery` contracts. Kept in their own module
 * (not `types.ts`, which is at the 500-line cap) so the discovery surface owns
 * its own data shapes — the same isolation lesson the P2B integration pass
 * recorded (parallel client-touching screens get their own api modules).
 */

export type DiscoveryVariant = "feature" | "bug" | "strategic";

export type PlacementKind = "slot_after" | "jump_backlog" | "interrupt";

export interface DiscoveryInsight {
  variant: DiscoveryVariant;
  source: string;
  sourceLabel: string;
  who: string;
  when: string;
  glyph: string;
  body: string;
}

export interface ProposedSpec {
  proposalId: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  dependsOn: string[];
  priority: "P0" | "P1" | "P2" | "tbd";
  estLabel: string;
}

export interface PlacementOption {
  kind: PlacementKind;
  label: string;
  eta: string;
  sideEffects: string;
  priority: string;
  recommended: boolean;
  risk: boolean;
}

export interface ImpactDelta {
  title: string;
  kind: "add" | "mod" | "impact";
  count: string;
  deltas: string[];
}

export interface DiscoveryResult {
  variant: DiscoveryVariant;
  summary: string;
  proposals: ProposedSpec[];
  placements: PlacementOption[];
  deltas: ImpactDelta[];
  readSummary: string;
}

export interface AcceptedSpec {
  proposalId: string;
  spec: {
    specId: string;
    projectId: string;
    title: string;
    status: string;
  };
}

export interface AcceptResult {
  accepted: AcceptedSpec[];
}
