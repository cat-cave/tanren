// P8b — the e2e CASE manifest (autonomy-engine §8b).
//
// This is the single typed source of truth for what the real-resource e2e gate
// proves. Each case names the capability it exercises, the operator-surface flow
// it drives (HTTP API + dashboard — never an internal seam), and the REAL
// persisted artifacts it asserts on. The harness (lib/harness.ts) reads this
// manifest and runs the cases that are `status: "active"`; capability
// placeholders (`status: "planned"`) are declared here so the suite's GROWTH is
// reviewable in one place as the autonomy engine lands.
//
// NEVER add a mocked/fixture artifact here: the e2e gate asserts on real merged
// PRs, real files on the base branch, real cost_records rows, and the real DORA
// projection. The `e2e-no-mock-imports` architecture check keeps the suite's
// imports honest; this manifest keeps its CLAIMS honest.

// The real external surfaces an e2e case is allowed to drive. There is no
// "internal" surface — that is the whole point of the gate (§8b: "no internal
// seams"). MCP is a tracked follow-up (autonomy-engine §6), added once the HTTP
// MCP server exists.
export type OperatorSurface = "http_api" | "dashboard";

// The kinds of REAL persisted artifact an e2e case asserts on. Every kind names
// a real, externally-observable thing — not a function return.
export type PersistedArtifactKind =
  // A merged pull request on GitHub (the merge SHA is on the base branch).
  | "merged_pr"
  // A specific file present on the base branch after the merge (the work landed).
  | "implemented_file"
  // cost_records rows with a real cost_basis (ccusage / provider_response) and a
  // real billing_mode — proof the run accounted real spend.
  | "cost_records"
  // The DORA projection accumulated from the merged run(s).
  | "dora_projection"
  // A spec row inserted into the DAG (priority + dependencies) by real-LLM
  // ideation / triage — proof the DAG was DERIVED, not hand-fed.
  | "dag_spec"
  // An issue ingested from a real source → a triaged candidate → a merged spec.
  | "ingested_issue";

export interface PersistedArtifactAssertion {
  readonly kind: PersistedArtifactKind;
  // A human-readable description of the exact real artifact this case checks
  // (e.g. "PR merged into main with the analytics endpoint file present").
  readonly describe: string;
}

// A case is one of:
//   - ACTIVE   — a live, credentialed proof the gate runs today against a real
//                stack (the three tier proofs).
//   - HERMETIC — a proof driven IN-PROCESS against fakes + the engine's real pure
//                decision functions (no creds / no network / no real Postgres), so
//                it is REGRESSION-PINNED in `just fast-check`. The apex proof surface
//                is hermetic: its driver lives in the orchestrator test suite
//                (services/orchestrator/tests/apexE2eDriver.ts — fakes are legal
//                there; the e2e-no-mock check forbids them under tests/e2e/**), and
//                THIS manifest entry is the single typed declaration of what that
//                hermetic driver proves.
//   - PLANNED  — a placeholder that lands with a specific autonomy-engine capability
//                (declared so the suite's shape is reviewable; skipped until wired).
export type CaseStatus = "active" | "hermetic" | "planned";

export interface E2eCase {
  // Stable id, used as the vitest case name and the proof-evidence key.
  readonly id: string;
  // The capability this case proves (maps to an autonomy-engine section).
  readonly capability: string;
  readonly status: CaseStatus;
  // The operator surfaces this case drives. The harness/check forbids any other
  // path to Tanren (no internal seams, no fixtures, no mocks).
  readonly surfaces: readonly OperatorSurface[];
  // The REAL persisted artifacts this case asserts on. Non-empty: a case that
  // asserts on nothing real is not a proof.
  readonly artifacts: readonly PersistedArtifactAssertion[];
  // For the three tier proofs: which acceptance fixture tier this drives.
  readonly tier?: "easy" | "medium" | "hard";
}

// The three tier proofs (easy/medium/hard → merged PR). These are ACTIVE: they
// wire against the existing acceptance fixtures (scripts/acceptance/**), driven
// over the real HTTP operator flow. Each asserts on a real merged PR + the
// implemented file on the base branch + real cost_records + the DORA projection.
const tierProofCases: readonly E2eCase[] = [
  {
    id: "tier-proof-easy",
    capability: "core-run-loop (autonomy-engine §0 A)",
    status: "active",
    tier: "easy",
    surfaces: ["http_api"],
    artifacts: [
      { kind: "merged_pr", describe: "the easy-tier spec is merged into the base branch as a real PR" },
      { kind: "implemented_file", describe: "the easy-tier target file is present on the base branch after merge" },
      { kind: "cost_records", describe: "write/check/audit cost_records rows with a real basis + billing_mode" },
      { kind: "dora_projection", describe: "the merged run shows up in the project DORA projection" },
    ],
  },
  {
    id: "tier-proof-medium",
    capability: "core-run-loop · subtask planning (autonomy-engine §0 A)",
    status: "active",
    tier: "medium",
    surfaces: ["http_api"],
    artifacts: [
      { kind: "merged_pr", describe: "the medium-tier multi-subtask spec is merged into the base branch" },
      { kind: "implemented_file", describe: "the medium-tier target files are present on the base branch after merge" },
      { kind: "cost_records", describe: "plan/write/check/audit cost_records rows with a real basis + billing_mode" },
      { kind: "dora_projection", describe: "the merged run accumulates into the project DORA projection" },
    ],
  },
  {
    id: "tier-proof-hard",
    capability: "core-run-loop · governance tier · private repo (autonomy-engine §0 A)",
    status: "active",
    tier: "hard",
    surfaces: ["http_api", "dashboard"],
    artifacts: [
      { kind: "merged_pr", describe: "the hard-tier spec is merged on the private repo after simulated review" },
      { kind: "implemented_file", describe: "the hard-tier target file is present on the private base branch" },
      { kind: "cost_records", describe: "the hard-tier run records real cost_records across roles" },
      { kind: "dora_projection", describe: "the hard-tier merge accumulates into the project DORA projection" },
    ],
  },
];

// Capability placeholders. These are PLANNED: each lands with the autonomy-engine
// capability named in `capability`. They are declared here so the e2e suite's
// forward shape is reviewable in one place; the harness skips them until their
// capability ships and the case flips to `status: "active"`.
const capabilityPlaceholderCases: readonly E2eCase[] = [
  {
    id: "real-llm-ideation-dag",
    capability: "real-LLM ideation → real DAG (autonomy-engine §1c/§3 proof 1-2)",
    status: "planned",
    surfaces: ["http_api", "dashboard"],
    artifacts: [
      { kind: "dag_spec", describe: "rough operator notes become real personas/behaviors and a derived spec DAG" },
    ],
  },
  {
    id: "walker-drives-multi-spec-dag",
    capability:
      "DAG-walker drives a multi-spec DAG to merged PRs, no per-spec trigger (autonomy-engine §1a/§3 proof 3)",
    status: "planned",
    surfaces: ["http_api", "dashboard"],
    artifacts: [
      { kind: "merged_pr", describe: "multiple specs reach merged PRs with zero per-spec operator triggers" },
      { kind: "dora_projection", describe: "DORA accumulates across the many autonomously-merged runs" },
    ],
  },
  {
    id: "intent-preserving-conflict",
    capability: "real conflict resolved intent-preserved (autonomy-engine §2b/§3 proof 4)",
    status: "planned",
    surfaces: ["http_api", "dashboard"],
    artifacts: [
      { kind: "merged_pr", describe: "two conflicting specs both merge with both intents preserved" },
      {
        kind: "implemented_file",
        describe: "the resolved file on the base branch satisfies both specs' acceptance criteria",
      },
    ],
  },
  {
    id: "issue-ingest-to-merged-spec",
    capability: "real issue ingest → triage → merged spec (autonomy-engine §1d/§3 proof 5)",
    status: "planned",
    surfaces: ["http_api", "dashboard"],
    artifacts: [
      { kind: "ingested_issue", describe: "a real issue is webhook-ingested, triaged, and becomes a spec in the DAG" },
      { kind: "merged_pr", describe: "the ingested spec executes and reaches a merged PR" },
    ],
  },
];

// The apex proof — HERMETIC (audit §6.8). No longer `planned`: the apex run is
// regression-pinned by an in-process driver
// (services/orchestrator/tests/apexE2eDriver.ts) that drives the FULL autonomy-loop
// proof surface against fakes + the engine's real pure decision functions, in
// `just fast-check`. This entry is its typed declaration; the live, credentialed
// apex (real surfaces, real deploy) remains the apex-validation the cutover is
// pending on, but the proof surface is no longer only anecdotal in a live run.
const apexHermeticCase: E2eCase = {
  id: "apex",
  capability: "apex — clean repo → deployed product (hermetic regression-pin; autonomy-engine §3/§4)",
  status: "hermetic",
  surfaces: ["http_api"],
  artifacts: [
    {
      kind: "dag_spec",
      describe: "Tanren authors the brief/personas/behaviors/DAG from rough notes (a template seed)",
    },
    {
      kind: "merged_pr",
      describe: "every derived + ingested spec is a merged PR (CAS land advances main), no per-spec human",
    },
    {
      kind: "implemented_file",
      describe: "the near-empty repo gains the URL-shortener API + web UI + Slack bot target files on base",
    },
    { kind: "cost_records", describe: "each role call carries the right cost_basis + billing_mode (subscription run)" },
    { kind: "dora_projection", describe: "DORA accumulates a deployment per merged run across the apex run" },
  ],
};

export const e2eManifest: readonly E2eCase[] = [...tierProofCases, apexHermeticCase, ...capabilityPlaceholderCases];

// validateManifest enforces the manifest's own invariants so a malformed case
// (duplicate id, an "active" case asserting on nothing real, a tier proof
// missing its tier) is caught by the harness unit test under `just fast-check`,
// long before any credentialed run. Returns the list of problems (empty = valid).
export function validateManifest(cases: readonly E2eCase[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const item of cases) {
    if (seen.has(item.id)) {
      problems.push(`duplicate case id: ${item.id}`);
    }
    seen.add(item.id);
    if (item.surfaces.length === 0) {
      problems.push(`${item.id}: a case must drive at least one operator surface`);
    }
    if (item.artifacts.length === 0) {
      problems.push(`${item.id}: a case must assert on at least one real persisted artifact`);
    }
    if (item.tier !== undefined && item.status !== "active") {
      problems.push(`${item.id}: a tier proof must be active (it wires against a real fixture)`);
    }
    if (item.status === "active" && item.tier === undefined) {
      problems.push(
        `${item.id}: only the tier proofs may be active today; capability cases stay planned/hermetic until wired`,
      );
    }
    // A hermetic case is driven in-process (not against a tier fixture), so it must
    // NOT carry a tier — its driver lives in the orchestrator suite, not here.
    if (item.status === "hermetic" && item.tier !== undefined) {
      problems.push(`${item.id}: a hermetic case is in-process; it must not carry an acceptance tier`);
    }
  }
  return problems;
}

export function activeCases(cases: readonly E2eCase[] = e2eManifest): readonly E2eCase[] {
  return cases.filter((item) => item.status === "active");
}

export function caseById(id: string, cases: readonly E2eCase[] = e2eManifest): E2eCase | undefined {
  return cases.find((item) => item.id === id);
}
