// spec discovery: deterministic, variant-aware discovery answerer.
//
// The fallback `DiscoveryAnswerer` used when no provider Answerer is wired —
// the analogue of the conversation `createDeterministicForgeAnswerer`. It is grounded
// (it reads the insight body + the existing-spec list it is handed) but
// deterministic, so the discovery endpoint is live without provider infra and
// the classification is testable without hitting an LLM. Production swaps in a
// provider-backed answerer via the engine's `answerer` dep.
//
// Each variant produces the proposed-spec(s) + the three canonical placement
// options (slot-after / jump-backlog / interrupt) + the impact-delta panel,
// mirroring the hi-fi `view-discovery` data shapes.

import type {
  DiscoveryAnswerer,
  DiscoveryAnswererContext,
  DiscoveryResult,
  ImpactDelta,
  PlacementOption,
  ProposedSpec,
} from "../../../src/engine/forge/discovery/types.js";

// The three canonical placement options, ordered by impact on existing work.
// `recommended`/`risk` differ per variant: a bug recommends the interrupt
// (urgent), a feature recommends jumping the backlog, strategic recommends
// slotting after current work (large, non-urgent).
function placementsFor(variant: DiscoveryResult["variant"]): PlacementOption[] {
  const recommend = variant === "bug" ? "interrupt" : variant === "strategic" ? "slot_after" : "jump_backlog";
  return [
    {
      kind: "slot_after",
      label: "slot in after current p1 work",
      eta: variant === "strategic" ? "ready ≈ 2 weeks" : "ready ≈ 2 weeks",
      sideEffects: "no other timelines move",
      priority: variant === "strategic" ? "new cluster · post-Q2" : "P2 · end of milestone",
      recommended: recommend === "slot_after",
      risk: false,
    },
    {
      kind: "jump_backlog",
      label: "jump the p1 backlog",
      eta: "ready ≈ 3 days",
      sideEffects: "next milestone slips ~2 days",
      priority: "P1 · next after P0s",
      recommended: recommend === "jump_backlog",
      risk: false,
    },
    {
      kind: "interrupt",
      label: "interrupt now",
      eta: variant === "bug" ? "ready ≈ 3 hours" : "ready ≈ 4 hours",
      sideEffects: variant === "bug" ? "pauses current backlog — fixes prod" : "pauses current p0 — not recommended",
      priority: "P0",
      recommended: recommend === "interrupt",
      risk: variant !== "bug",
    },
  ];
}

function featureProposals(): ProposedSpec[] {
  return [
    {
      proposalId: "p1",
      title: "add csv export to the stats page",
      description:
        "Add a CSV export to the stats page so the persona can pull the data for an external report. Deliverable: an export button plus a GET endpoint that streams the current stats as CSV, with one BDD test.",
      acceptanceCriteria: [
        "given a user on the stats page, when they click export, then a CSV of the current stats downloads",
        "given the export endpoint, when called, then it returns text/csv with a header row",
      ],
      dependsOn: [],
      priority: "P1",
      estLabel: "2h · $0.45",
    },
  ];
}

function bugProposals(): ProposedSpec[] {
  return [
    {
      proposalId: "p1",
      title: "fix session race · await flush before read",
      description:
        "Await the session flush before the read so the post-write read can no longer race (the ~3% intermittent-login root cause).",
      acceptanceCriteria: ["given a login, when the session is written, then the subsequent read always observes it"],
      dependsOn: [],
      priority: "P0",
      estLabel: "1h · $0.28",
    },
    {
      proposalId: "p2",
      title: "harden auth e2e · remove @flaky quarantine",
      description: "Remove the @flaky quarantine on the auth e2e and stabilise it against the fixed session path.",
      acceptanceCriteria: ["given the auth e2e, when run 20x, then it passes every time without the @flaky tag"],
      dependsOn: [],
      priority: "P0",
      estLabel: "1.5h · $0.34",
    },
    {
      proposalId: "p3",
      title: "add session-read trace · catch future regressions",
      description:
        "Add a trace around session reads so a future pre-flush regression is caught in observability before it ships.",
      acceptanceCriteria: ["given a session read, when it occurs, then a trace span records write→read ordering"],
      dependsOn: [],
      priority: "P1",
      estLabel: "45m · $0.18",
    },
  ];
}

function strategicProposals(): ProposedSpec[] {
  const clusters: Array<[string, string, string]> = [
    ["connect · oauth to the new ads api", "OAuth connect flow to the third-party ads API.", "P1 · 3 specs"],
    ["campaign · create / edit / pause crud", "Campaign CRUD: create, edit, and pause campaigns.", "P1 · 4 specs"],
    ["creatives · upload / tag / preview", "Creative upload with tagging and a pre-publish preview.", "P2 · 3 specs"],
    [
      "reporting · pivot · csv export · pacing alerts",
      "Pivot reporting, CSV export, and pacing alerts.",
      "P2 · 4 specs",
    ],
  ];
  return clusters.map(([title, description, estLabel], i) => ({
    proposalId: `p${i + 1}`,
    title,
    description,
    acceptanceCriteria: [
      `given the new persona, when they use ${title.split(" · ")[0]}, then the cluster behavior is demonstrated`,
    ],
    dependsOn: [],
    priority: i < 2 ? ("P1" as const) : ("P2" as const),
    estLabel,
  }));
}

function deltasFor(variant: DiscoveryResult["variant"], proposals: ProposedSpec[]): ImpactDelta[] {
  if (variant === "bug") {
    return [
      {
        title: "personas",
        kind: "impact",
        count: "all authed users",
        deltas: ["all authed users · existing · trust restored"],
      },
      {
        title: "behaviors",
        kind: "mod",
        count: "1 hardened",
        deltas: ["user logs in · existing · reliable-in-fact"],
      },
      {
        title: "specs",
        kind: "add",
        count: `${proposals.length} proposed`,
        deltas: proposals.map((p) => `${p.priority} · ${p.title} · ${p.estLabel}`),
      },
    ];
  }
  if (variant === "strategic") {
    return [
      {
        title: "personas",
        kind: "add",
        count: "2 new",
        deltas: ["ad manager · campaigns + reports", "content creator · uploads + tags"],
      },
      {
        title: "behaviors",
        kind: "add",
        count: "8 new",
        deltas: ["connect · launch · pause · pacing alert · pivot report", "upload creative · tag + caption · preview"],
      },
      {
        title: "specs",
        kind: "add",
        count: `${proposals.length} cluster heads`,
        deltas: proposals.map((p) => `${p.title} · ${p.estLabel}`),
      },
    ];
  }
  return [
    {
      title: "personas",
      kind: "impact",
      count: "1 impacted",
      deltas: ["existing persona · gains 1 new behavior"],
    },
    {
      title: "behaviors",
      kind: "add",
      count: "1 added",
      deltas: ["export stats data · for an external report"],
    },
    {
      title: "specs",
      kind: "add",
      count: `${proposals.length} proposed`,
      deltas: proposals.map((p) => `${p.title} · ${p.priority} · ${p.estLabel}`),
    },
  ];
}

function proposalsFor(variant: DiscoveryResult["variant"]): ProposedSpec[] {
  if (variant === "bug") return bugProposals();
  if (variant === "strategic") return strategicProposals();
  return featureProposals();
}

function summaryFor(variant: DiscoveryResult["variant"]): string {
  switch (variant) {
    case "bug":
      return "Read the issue + the code. The failing behavior is in your DAG; the spec that built it carries a flaky test. That's the symptom — the root cause is a pre-flush session read. Three specs close it.";
    case "strategic":
      return "This is a meaningful add — two new personas and eight new behaviors. The specs land in a new cluster that depends on your existing auth + billing modules. A cluster this size auto-suggests forking to a sibling project.";
    default:
      return "Read the insight. The persona is already in your DAG and has the upstream behavior — this fills the one behavior gap the insight is asking for. One spec covers it.";
  }
}

export function createDeterministicDiscoveryAnswerer(): DiscoveryAnswerer {
  return {
    async classify(context: DiscoveryAnswererContext): Promise<DiscoveryResult> {
      const variant = context.insight.variant;
      const proposals = proposalsFor(variant);
      // Ground `dependsOn` against the live DAG: when the project already has a
      // "done"/"merged" spec, the lead proposal depends on the first such spec
      // (the feature builds on shipped work) — purely deterministic.
      const upstream = context.existingSpecs.find((s) => ["done", "merged"].includes(s.status.toLowerCase()));
      if (variant === "feature" && upstream !== undefined && proposals[0] !== undefined) {
        proposals[0] = { ...proposals[0], dependsOn: [upstream.specId] };
      }
      return {
        variant,
        summary: summaryFor(variant),
        proposals,
        placements: placementsFor(variant),
        deltas: deltasFor(variant, proposals),
        readSummary: `grounded on ${context.existingSpecs.length} existing spec(s)`,
      };
    },
  };
}
