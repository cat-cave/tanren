export const DB_GATES = [
  "smoke-plane-split-p3",
  "smoke-plane-split-p3b",
  "smoke-plane-split-p3c",
  "smoke-rls-r1",
  "smoke-rls-r2",
  "smoke-rls-r2-cohort2",
  "smoke-rls-r2-cohort3",
  "smoke-rls-r2-cohort4",
  "smoke-rls-r3a",
  "smoke-rls-r3a-worker",
  "smoke-rls-r3b",
  "smoke-rls-early-finalize",
  "smoke-rls-org-bootstrap",
  "smoke-rls-operator-flow",
  "smoke-rls-http-route-scoping",
  "smoke-rls-run-lifecycle",
  "smoke-rls-allocator",
  "smoke-rls-environments",
  "smoke-rls-design-contracts",
  "smoke-e2e-artifacts",
  "smoke-budget-gate",
  "smoke-merge-authority",
] as const;

export type DbGateName = (typeof DB_GATES)[number];

export type StageKind = "preflight" | "setup" | "mutation" | "proof" | "db" | "final" | "finalize";

export interface StageDescriptor {
  readonly name: SmokeStage;
  readonly kind: StageKind;
  /** Stage is always entered; body may no-op when the optional condition is false. */
  readonly optional?: boolean;
}

/** Non-DB production stages — const so `SmokeStage` is an exact literal union. */
const PRE_DB_STAGES = [
  { name: "preflight-git-identity", kind: "preflight" },
  { name: "allocate-runtime-root", kind: "setup" },
  { name: "isolate-home", kind: "setup" },
  { name: "resolve-runtime", kind: "setup" },
  { name: "attest-runtime", kind: "setup" },
  { name: "archive-candidate", kind: "setup" },
  { name: "materialize-explicit-env", kind: "setup" },
  { name: "setup-runner-key", kind: "setup" },
  { name: "setup-mtls", kind: "setup" },
  { name: "snapshot-checkout", kind: "setup" },
  { name: "build-images", kind: "mutation" },
  { name: "attest-images", kind: "mutation" },
  { name: "start-stack", kind: "mutation" },
  { name: "discover-published-ports", kind: "mutation" },
  { name: "bind-discovered-config", kind: "mutation" },
  { name: "stabilize-containers", kind: "mutation" },
  { name: "semantic-stack", kind: "proof" },
  { name: "runner-ssh", kind: "proof" },
  { name: "seed-platform-credentials", kind: "proof", optional: true },
  { name: "cli-doctor", kind: "proof" },
  { name: "connectivity", kind: "proof" },
  { name: "ssh-integration", kind: "proof" },
  { name: "plane-split-worker", kind: "proof" },
  { name: "cli-status", kind: "proof" },
] as const satisfies readonly { readonly name: string; readonly kind: StageKind; readonly optional?: boolean }[];

const POST_DB_STAGES = [
  { name: "final-container-attestation", kind: "final" },
  { name: "final-semantic-stack", kind: "final" },
  { name: "final-runner-ssh", kind: "final" },
  { name: "assert-checkout-unchanged", kind: "final" },
  { name: "capture-compose-logs", kind: "finalize" },
  { name: "teardown-stack", kind: "finalize" },
  { name: "attest-resource-leaks", kind: "finalize" },
  { name: "remove-build-context", kind: "finalize" },
  { name: "remove-runtime-dir", kind: "finalize" },
  { name: "publish-receipt", kind: "finalize" },
] as const satisfies readonly { readonly name: string; readonly kind: StageKind; readonly optional?: boolean }[];

export type SmokeStage = (typeof PRE_DB_STAGES)[number]["name"] | DbGateName | (typeof POST_DB_STAGES)[number]["name"];

/**
 * Ordered production stage registry. The coordinator walks this list exactly —
 * synthetic stage-name arrays are not a second source of truth.
 */
export const STAGE_REGISTRY: readonly StageDescriptor[] = [
  ...PRE_DB_STAGES,
  ...DB_GATES.map((name) => ({ name, kind: "db" as const })),
  ...POST_DB_STAGES,
];

export const SMOKE_STAGES: readonly SmokeStage[] = STAGE_REGISTRY.map((stage) => stage.name);

const SMOKE_STAGE_SET: ReadonlySet<string> = new Set(SMOKE_STAGES);

export function isSmokeStage(value: string): value is SmokeStage {
  return SMOKE_STAGE_SET.has(value);
}

export function stageDescriptor(name: SmokeStage): StageDescriptor {
  const found = STAGE_REGISTRY.find((stage) => stage.name === name);
  if (found === undefined) throw new Error(`unknown smoke stage ${name}`);
  return found;
}
