// cspell:ignore mqeval mqgrp mqwake
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { EventRegistry, listEventNames, listSensitivityPathsFor, sensitivityFor } from "../src/engine/events/index.js";
import { helloEventRegistry } from "../src/engine/events/schemas/integrations.js";
import { defaultSeverityFor } from "../src/engine/notifications/index.js";

const W0_EVENT_NAMES = [
  "integration.requirement.validated",
  "behavior.coverage.selection_analyzed",
  "governance.audit_posture.updated",
  "review.simulated_intent",
  "merge.signal.classified",
  "merge.member.policy_blocked",
] as const;

type W0EventName = (typeof W0_EVENT_NAMES)[number];

const eventTypesSeed = [
  ...readFileSync(new URL("../../../db/src/eventTypesSeed.ts", import.meta.url), "utf8").matchAll(
    /\{ name: "(?<name>[^"]+)", defaultSeverity: "(?<defaultSeverity>ok|info|warn|fail)" \}/gu,
  ),
].map(({ groups }) => ({
  name: groups?.["name"] ?? "",
  defaultSeverity: groups?.["defaultSeverity"] ?? "",
}));
const eventVocabularyMigrationSource = readFileSync(
  new URL("../../../db/migrations/0042_event_vocabulary_w0.sql", import.meta.url),
  "utf8",
);

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const EVALUATION_ID = `mqeval_${"a".repeat(64)}`;
const GROUP_ID = `mqgrp_${"b".repeat(64)}`;
const WAKE_KEY = `mqwake_${"c".repeat(64)}`;
const REVIEW_MARKER = "tanren-simulated-review:v1:approved";

const integrationRequirement = {
  missionNodeId: "in-2",
  requirementDigest: DIGEST_A,
  artifact: {
    digest: DIGEST_B,
    byteSize: 42,
    mediaType: "application/vnd.tanren.integration-requirement.v1+json",
  },
  capability: "github.pull_request.read",
  plane: "control",
  direction: "inbound",
  criticality: "merge_required",
};

const behaviorCoverage = {
  version: "v1",
  analysisId: "analysis-1",
  mode: "targeted",
  changedTargets: [{ kind: "source", targetRef: "services/orchestrator/src/index.ts" }],
  unknownTargets: [{ kind: "component", targetRef: "unknown-component" }],
  selected: [
    {
      behaviorRevisionId: "behavior-revision-1",
      reasons: [
        {
          kind: "direct_edge",
          edgeId: "edge-1",
          target: { kind: "source", targetRef: "services/orchestrator/src/index.ts" },
        },
        {
          kind: "transitive_dependency",
          edgeId: "edge-2",
          dependencyBehaviorRevisionId: "behavior-revision-0",
        },
        { kind: "unknown_target", target: { kind: "component", targetRef: "unknown-component" } },
        { kind: "uncovered_behavior" },
        { kind: "dangling_dependency", edgeId: "edge-3", targetRef: "missing-behavior" },
        { kind: "no_changed_targets" },
      ],
    },
  ],
  excluded: [
    {
      behaviorRevisionId: "behavior-revision-2",
      reason: "no_reachable_changed_target",
      inspectedEdgeIds: ["edge-4"],
    },
  ],
};

const governancePosture = {
  actorUserId: "user-1",
  previous: {
    blockReviewAt: "P1",
    p2p3Handling: "fix-if-idle",
    autonomousRemediation: false,
  },
  current: {
    blockReviewAt: "P0",
    p2p3Handling: "route-to-dag",
    autonomousRemediation: true,
  },
};

const reviewIntent = {
  headSha: "a".repeat(40),
  state: "approved",
  event: "APPROVE",
  body: `Simulated review intent\n${REVIEW_MARKER}\nNo forge authority.`,
  message: "Review simulation only",
  reviewerLogin: "tanren-simulator",
  marker: REVIEW_MARKER,
};

const mergeIdentity = {
  missionNodeId: "mq-1",
  evaluationId: EVALUATION_ID,
  groupId: GROUP_ID,
  signalVersion: "merge_signal.v1",
};

const deterministicPolicy = {
  ...mergeIdentity,
  memberIds: ["member-a", "member-b"],
  findingIds: ["finding-a", "finding-b"],
  classification: "deterministic_policy",
  reasonCode: "audit_policy",
  retryability: "non_retryable",
  wakeKey: null,
  disposition: "member_repair",
};

const transientInfrastructure = {
  ...mergeIdentity,
  memberIds: [],
  findingIds: [],
  classification: "transient_infrastructure",
  reasonCode: "runner_transport",
  retryability: "retryable",
  wakeKey: WAKE_KEY,
  disposition: "retry_when_ready",
};

const needsProductDecision = {
  ...mergeIdentity,
  memberIds: [],
  findingIds: [],
  classification: "needs_product_decision",
  reasonCode: "review_changes_requested",
  retryability: "non_retryable",
  wakeKey: WAKE_KEY,
  disposition: "await_product_decision",
};

const unknownFailClosed = {
  ...mergeIdentity,
  memberIds: [],
  findingIds: ["finding-a"],
  classification: "unknown_fail_closed",
  reasonCode: "untyped_evidence",
  retryability: "unknown",
  wakeKey: null,
  disposition: "hold_fail_closed",
};

const validPayloads: Record<W0EventName, unknown> = {
  "integration.requirement.validated": integrationRequirement,
  "behavior.coverage.selection_analyzed": behaviorCoverage,
  "governance.audit_posture.updated": governancePosture,
  "review.simulated_intent": reviewIntent,
  "merge.signal.classified": deterministicPolicy,
  "merge.member.policy_blocked": deterministicPolicy,
};

const expectedSensitivityPaths: Record<W0EventName, readonly string[]> = {
  "integration.requirement.validated": [
    "missionNodeId",
    "requirementDigest",
    "artifact.digest",
    "artifact.byteSize",
    "artifact.mediaType",
    "capability",
    "plane",
    "direction",
    "criticality",
  ],
  "behavior.coverage.selection_analyzed": [
    "version",
    "analysisId",
    "mode",
    "changedTargets",
    "changedTargets[].kind",
    "changedTargets[].targetRef",
    "unknownTargets",
    "unknownTargets[].kind",
    "unknownTargets[].targetRef",
    "selected",
    "selected[].behaviorRevisionId",
    "selected[].reasons",
    "selected[].reasons[].kind",
    "selected[].reasons[].edgeId",
    "selected[].reasons[].target.kind",
    "selected[].reasons[].target.targetRef",
    "selected[].reasons[].dependencyBehaviorRevisionId",
    "selected[].reasons[].targetRef",
    "excluded",
    "excluded[].behaviorRevisionId",
    "excluded[].reason",
    "excluded[].inspectedEdgeIds",
    "excluded[].inspectedEdgeIds[]",
  ],
  "governance.audit_posture.updated": [
    "actorUserId",
    "previous.blockReviewAt",
    "previous.p2p3Handling",
    "previous.autonomousRemediation",
    "current.blockReviewAt",
    "current.p2p3Handling",
    "current.autonomousRemediation",
  ],
  "review.simulated_intent": ["headSha", "state", "event", "body", "message", "reviewerLogin", "marker"],
  "merge.signal.classified": mergeSensitivityPaths(),
  "merge.member.policy_blocked": mergeSensitivityPaths(),
};

function mergeSensitivityPaths(): readonly string[] {
  return [
    "missionNodeId",
    "evaluationId",
    "groupId",
    "signalVersion",
    "memberIds",
    "memberIds[]",
    "findingIds",
    "findingIds[]",
    "classification",
    "reasonCode",
    "retryability",
    "wakeKey",
    "disposition",
  ];
}

function parses(eventName: W0EventName, payload: unknown): boolean {
  return EventRegistry[eventName].safeParse(payload).success;
}

describe("mission-complete W0 event vocabulary", () => {
  it("registers exactly the six frozen names with their generated seed severities", () => {
    for (const eventName of W0_EVENT_NAMES) {
      expect(listEventNames()).toContain(eventName);
      expect(parses(eventName, validPayloads[eventName])).toBe(true);
    }

    expect(eventTypesSeed.filter(({ name }) => (W0_EVENT_NAMES as readonly string[]).includes(name))).toEqual([
      { name: "behavior.coverage.selection_analyzed", defaultSeverity: "info" },
      { name: "governance.audit_posture.updated", defaultSeverity: "info" },
      { name: "integration.requirement.validated", defaultSeverity: "info" },
      { name: "merge.member.policy_blocked", defaultSeverity: "warn" },
      { name: "merge.signal.classified", defaultSeverity: "info" },
      { name: "review.simulated_intent", defaultSeverity: "info" },
    ]);
    expect(W0_EVENT_NAMES.map((name) => [name, defaultSeverityFor(name)])).toEqual([
      ["integration.requirement.validated", "info"],
      ["behavior.coverage.selection_analyzed", "info"],
      ["governance.audit_posture.updated", "info"],
      ["review.simulated_intent", "info"],
      ["merge.signal.classified", "info"],
      ["merge.member.policy_blocked", "warn"],
    ]);
  });

  it("keeps migration 0042 additive, idempotent, and equal to the frozen rows", () => {
    const migrationRows = [
      ...eventVocabularyMigrationSource.matchAll(/\('(?<name>[^']+)', '(?<severity>[^']+)'\)/gu),
    ].map(({ groups }) => ({ name: groups?.["name"], defaultSeverity: groups?.["severity"] }));
    expect(migrationRows).toEqual([
      { name: "integration.requirement.validated", defaultSeverity: "info" },
      { name: "behavior.coverage.selection_analyzed", defaultSeverity: "info" },
      { name: "governance.audit_posture.updated", defaultSeverity: "info" },
      { name: "review.simulated_intent", defaultSeverity: "info" },
      { name: "merge.signal.classified", defaultSeverity: "info" },
      { name: "merge.member.policy_blocked", defaultSeverity: "warn" },
    ]);
    expect(eventVocabularyMigrationSource).toContain('ON CONFLICT ("name") DO NOTHING;');
    expect(eventVocabularyMigrationSource).not.toContain("ALTER ");
    expect(eventVocabularyMigrationSource).not.toContain("CREATE ");
  });

  it("preserves the four hello registry entries through extraction", () => {
    expect(Object.keys(helloEventRegistry)).toEqual([
      "hello.started",
      "hello.ssh_started",
      "hello.ssh_completed",
      "hello.completed",
    ]);
    for (const [name, schema] of Object.entries(helloEventRegistry)) {
      expect(EventRegistry[name as keyof typeof helloEventRegistry]).toBe(schema);
    }
  });

  it("rejects unknown keys at every frozen object boundary", () => {
    expect(parses("integration.requirement.validated", { ...integrationRequirement, unexpected: true })).toBe(false);
    expect(
      parses("integration.requirement.validated", {
        ...integrationRequirement,
        artifact: { ...integrationRequirement.artifact, unexpected: true },
      }),
    ).toBe(false);
    expect(
      parses("behavior.coverage.selection_analyzed", {
        ...behaviorCoverage,
        changedTargets: [{ ...behaviorCoverage.changedTargets[0], unexpected: true }],
      }),
    ).toBe(false);
    expect(parses("behavior.coverage.selection_analyzed", { ...behaviorCoverage, unexpected: true })).toBe(false);
    expect(
      parses("behavior.coverage.selection_analyzed", {
        ...behaviorCoverage,
        selected: [{ ...behaviorCoverage.selected[0], unexpected: true }],
      }),
    ).toBe(false);
    for (const reason of behaviorCoverage.selected[0]?.reasons ?? []) {
      expect(
        parses("behavior.coverage.selection_analyzed", {
          ...behaviorCoverage,
          selected: [{ ...behaviorCoverage.selected[0], reasons: [{ ...reason, unexpected: true }] }],
        }),
      ).toBe(false);
    }
    expect(
      parses("behavior.coverage.selection_analyzed", {
        ...behaviorCoverage,
        excluded: [{ ...behaviorCoverage.excluded[0], unexpected: true }],
      }),
    ).toBe(false);
    expect(parses("governance.audit_posture.updated", { ...governancePosture, unexpected: true })).toBe(false);
    expect(
      parses("governance.audit_posture.updated", {
        ...governancePosture,
        previous: { ...governancePosture.previous, unexpected: true },
      }),
    ).toBe(false);
    expect(parses("review.simulated_intent", { ...reviewIntent, unexpected: true })).toBe(false);
    for (const signal of [deterministicPolicy, transientInfrastructure, needsProductDecision, unknownFailClosed]) {
      expect(parses("merge.signal.classified", { ...signal, unexpected: true })).toBe(false);
    }
    expect(parses("merge.member.policy_blocked", { ...deterministicPolicy, unexpected: true })).toBe(false);
  });

  it("enforces integration digests and review state/event/marker/body coherence", () => {
    expect(
      parses("integration.requirement.validated", {
        ...integrationRequirement,
        requirementDigest: `sha256:${"A".repeat(64)}`,
      }),
    ).toBe(false);
    expect(parses("review.simulated_intent", { ...reviewIntent, event: "REQUEST_CHANGES" })).toBe(false);
    expect(
      parses("review.simulated_intent", {
        ...reviewIntent,
        marker: REVIEW_MARKER.replace("approved", "changes_requested"),
      }),
    ).toBe(false);
    expect(parses("review.simulated_intent", { ...reviewIntent, body: `prefix-${REVIEW_MARKER}-suffix` })).toBe(false);
    expect(
      parses("review.simulated_intent", {
        ...reviewIntent,
        state: "changes_requested",
        event: "REQUEST_CHANGES",
        marker: "tanren-simulated-review:v1:changes_requested",
        body: "intent\ntanren-simulated-review:v1:changes_requested",
      }),
    ).toBe(true);
  });

  it("accepts all four merge-signal arms and rejects cross-arm invariant violations", () => {
    for (const signal of [deterministicPolicy, transientInfrastructure, needsProductDecision, unknownFailClosed]) {
      expect(parses("merge.signal.classified", signal)).toBe(true);
    }

    expect(parses("merge.signal.classified", { ...deterministicPolicy, memberIds: [] })).toBe(false);
    expect(parses("merge.signal.classified", { ...deterministicPolicy, findingIds: ["finding-b", "finding-a"] })).toBe(
      false,
    );
    expect(parses("merge.signal.classified", { ...transientInfrastructure, memberIds: ["member-a"] })).toBe(false);
    expect(parses("merge.signal.classified", { ...transientInfrastructure, wakeKey: null })).toBe(false);
    expect(parses("merge.signal.classified", { ...needsProductDecision, retryability: "retryable" })).toBe(false);
    expect(parses("merge.signal.classified", { ...unknownFailClosed, memberIds: ["member-a"] })).toBe(false);
    expect(parses("merge.signal.classified", { ...unknownFailClosed, findingIds: ["finding-a", "finding-a"] })).toBe(
      false,
    );
    expect(parses("merge.signal.classified", { ...unknownFailClosed, evaluationId: `mqeval_${"A".repeat(64)}` })).toBe(
      false,
    );
  });

  it("keeps member policy blocks fixed, non-empty, canonical, and policy-only", () => {
    expect(parses("merge.member.policy_blocked", deterministicPolicy)).toBe(true);
    expect(parses("merge.member.policy_blocked", { ...deterministicPolicy, memberIds: [] })).toBe(false);
    expect(parses("merge.member.policy_blocked", { ...deterministicPolicy, findingIds: [] })).toBe(false);
    expect(parses("merge.member.policy_blocked", { ...deterministicPolicy, memberIds: ["member-b", "member-a"] })).toBe(
      false,
    );
    expect(parses("merge.member.policy_blocked", transientInfrastructure)).toBe(false);
  });

  it("registers exactly the frozen public sensitivity paths", () => {
    for (const eventName of W0_EVENT_NAMES) {
      const actualPaths = [...listSensitivityPathsFor(eventName)].sort();
      const expectedPaths = [...expectedSensitivityPaths[eventName]].sort();
      expect(actualPaths).toEqual(expectedPaths);
      for (const path of actualPaths) {
        expect(sensitivityFor(eventName, path)).toBe("public");
      }
    }
  });
});
