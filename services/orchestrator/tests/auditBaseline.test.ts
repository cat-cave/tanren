// AUDIT-EVIDENCE + SECURITY-BASELINE coverage (tanren-direction.md §§ "Audit And
// Compliance Baseline" + "Security Baseline"). These tests pin the audit MODEL the
// schemas teach — independent of any one emit site:
//   1. Every governing event (gate.verdict / deploy.* / merge.completed) accepts the
//      shared audit envelope (policy version + initiating/approving actor) and EVERY
//      envelope field has a `public` sensitivity tag (no secret surface).
//   2. The security-baseline cleanup-proof (`release.finalized`) shape + sensitivity.
//   3. The egress / deploy-target allowlist seam's default-permissive policy.
//   4. The actor projection + the no-secret-value invariant across the envelope.

import { describe, expect, it } from "vitest";
import { AuditActor, AuditEnvelope, auditActorFromRef, serviceAuditActor } from "../src/engine/events/schemas/audit.js";
import { EventRegistry, sensitivityFor } from "../src/engine/events/index.js";
import { DeployArtifact } from "../src/engine/events/schemas/deploy.js";
import {
  DEFAULT_PERMISSIVE_REASON,
  DefaultPermissiveEgressPolicy,
  defaultEgressPolicy,
} from "../src/engine/security/egressPolicy.js";

const GOVERNING_EVENTS = ["gate.verdict", "deploy.triggered", "deploy.verified", "merge.completed"] as const;
const ENVELOPE_PATHS = [
  "policyVersion",
  "initiatingActor.kind",
  "initiatingActor.id",
  "initiatingActor.label",
  "approvingActor.kind",
  "approvingActor.id",
  "approvingActor.label",
] as const;

describe("audit-evidence baseline — the shared envelope", () => {
  it("every governing event's schema accepts the audit envelope (policy version + actors)", () => {
    const envelope = {
      policyVersion: 3,
      initiatingActor: { kind: "service" as const, id: "tanren-engine" },
      approvingActor: { kind: "human" as const, id: "u_42", label: "alice" },
    };
    // gate.verdict
    expect(() =>
      EventRegistry["gate.verdict"].parse({
        when: "pre_merge",
        headSha: "a".repeat(40),
        passed: true,
        durationMs: 5,
        tiers: ["fast"],
        steps: [],
        ...envelope,
      }),
    ).not.toThrow();
    // deploy.triggered (+ artifact)
    expect(() =>
      EventRegistry["deploy.triggered"].parse({
        provider: "deploy.vercel",
        appId: "app_1",
        repo: "acme/widget",
        ref: "main",
        deploymentId: "d_1",
        url: "https://x.vercel.app",
        state: "READY",
        artifact: { provenanceRef: "deploy.vercel:d_1@main" },
        ...envelope,
      }),
    ).not.toThrow();
    // merge.completed
    expect(() =>
      EventRegistry["merge.completed"].parse({
        prUrl: "https://github.com/acme/widget/pull/7",
        prNumber: 7,
        integration: "native_queue",
        mergeSha: "sha",
        ...envelope,
      }),
    ).not.toThrow();
  });

  it("registers a public sensitivity tag for every envelope field on every governing event", () => {
    const untagged: string[] = [];
    for (const eventName of GOVERNING_EVENTS) {
      for (const path of ENVELOPE_PATHS) {
        if (sensitivityFor(eventName, path) !== "public") {
          untagged.push(`${eventName}.${path}`);
        }
      }
    }
    expect(untagged).toEqual([]);
  });

  it("the envelope is OPTIONAL — a fixture/historical event without it still validates", () => {
    expect(() =>
      EventRegistry["merge.completed"].parse({
        prUrl: "https://github.com/acme/widget/pull/7",
        prNumber: 7,
        integration: "native_queue",
      }),
    ).not.toThrow();
  });

  it("an audit actor is a kind + opaque handle only — projection maps operator→human, else→service", () => {
    expect(auditActorFromRef({ kind: "operator", id: "u_1", label: "bob" })).toEqual({
      kind: "human",
      id: "u_1",
      label: "bob",
    });
    expect(auditActorFromRef({ kind: "writer" })).toEqual({ kind: "service" });
    expect(serviceAuditActor).toEqual({ kind: "service", id: "tanren-engine" });
  });

  it("rejects a non-secret-violating shape only — the actor carries no value field", () => {
    // The AuditActor schema is `.strict()`: an extra field (e.g. a leaked token) is
    // rejected, so a credential value can never ride along in the actor.
    expect(() => AuditActor.parse({ kind: "human", token: "secret" })).toThrow(/unrecognized/iu);
    // A well-formed envelope round-trips with no surprise fields.
    const parsed = AuditEnvelope.parse({ policyVersion: 1, initiatingActor: { kind: "service" } });
    expect(JSON.stringify(parsed)).not.toMatch(/secret|token|password/iu);
  });
});

describe("security baseline — cleanup-proof + deploy artifact provenance", () => {
  it("release.finalized records the teardown verdict + residual resources (all public)", () => {
    const clean = EventRegistry["release.finalized"].parse({
      runnerId: "runner_1",
      cleanedUp: true,
      residualResources: [],
    });
    expect(clean.cleanedUp).toBe(true);
    const failed = EventRegistry["release.finalized"].parse({
      runnerId: "runner_1",
      cleanedUp: false,
      residualResources: ["runner:runner_1"],
      failureReason: "provider 500",
    });
    expect(failed.residualResources).toEqual(["runner:runner_1"]);
    const untagged = ["runnerId", "cleanedUp", "residualResources", "residualResources[]", "failureReason"].filter(
      (path) => sensitivityFor("release.finalized", path) !== "public",
    );
    expect(untagged).toEqual([]);
  });

  it("the deploy artifact requires a provenance ref but the checksum is optional (honest absence)", () => {
    expect(() => DeployArtifact.parse({ provenanceRef: "deploy.vercel:d_1@main" })).not.toThrow();
    // provenanceRef is required — a checksum alone is rejected.
    expect(() => DeployArtifact.parse({ checksum: "sha256:abc" })).toThrow(/provenanceRef/iu);
    expect(sensitivityFor("deploy.triggered", "artifact.checksum")).toBe("public");
    expect(sensitivityFor("deploy.triggered", "artifact.provenanceRef")).toBe("public");
  });
});

describe("security baseline — egress / deploy-target allowlist seam", () => {
  it("the default-permissive policy allows every egress + deploy target with the fixed reason", () => {
    const policy = new DefaultPermissiveEgressPolicy();
    expect(policy.allowsEgress({ host: "api.vercel.com", port: 443 })).toEqual({
      allowed: true,
      reason: DEFAULT_PERMISSIVE_REASON,
    });
    expect(policy.allowsDeployTarget({ provider: "deploy.flyio", appId: "app_2" })).toEqual({
      allowed: true,
      reason: DEFAULT_PERMISSIVE_REASON,
    });
  });

  it("the shared default instance is the default-permissive policy", () => {
    expect(defaultEgressPolicy.allowsDeployTarget({ provider: "x", appId: "y" }).allowed).toBe(true);
  });
});
