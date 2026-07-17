// in-5: the deterministic requirement compiler — determinism, hash-match, and the
// negative controls (ambiguous/unobservable → typed failure, never a guessed row).

import { describe, expect, it } from "vitest";
import { integrationRequirementDigest, parseIntegrationRequirement } from "../src/engine/contracts/integrationRequirement.js";
import { compileIntegrationRequirement } from "../src/engine/forge/interview/compileIntegrationRequirement.js";
import type { CaptureBehavior, CaptureDesignContract } from "../src/engine/forge/interview/types.js";

// `then` is BDD Given/When/Then vocabulary (the CaptureBehavior field name), used
// pervasively below — the thenable-object lint does not apply to these fixtures.
/* eslint-disable unicorn/no-thenable */

function behavior(over: Partial<CaptureBehavior>): CaptureBehavior {
  return {
    persona: over.persona ?? "operator",
    title: over.title ?? "do a thing",
    given: over.given ?? "",
    when: over.when ?? "",
    then: over.then ?? "",
  };
}

const slackCelebrate = behavior({
  persona: "operator",
  title: "celebrate 100 clicks",
  given: "a short link has 99 clicks",
  when: "the 100th click is recorded",
  then: "a celebratory message is posted to our Slack channel",
});

describe("compileIntegrationRequirement — positive (messaging.send / slack)", () => {
  it("compiles a Slack celebration behavior to a product messaging.send requirement", () => {
    const result = compileIntegrationRequirement(slackCelebrate, null);
    expect(result.kind).toBe("requirement");
    if (result.kind !== "requirement") return;

    const req = result.requirement;
    expect(req.capability).toBe("messaging.send");
    expect(req.plane).toBe("product");
    expect(req.direction).toBe("outbound");
    expect(req.providerPolicy.preferred).toEqual(["slack"]);
    expect(req.providerPolicy.allowed).toEqual(["slack"]);
    expect(req.expectedEffect.provider).toBe("slack");
    expect(req.expectedEffect.observation).toBe("message_in_channel");
    expect(req.expectedEffect.independent).toBe(true);
    expect(req.trigger.kind).toBe("threshold");
    expect(req.trigger.behaviorKey).toBe("operator::celebrate 100 clicks");
    expect(req.criticality).toBe("release_required");

    // A compiled requirement is always a valid in-2 document.
    expect(parseIntegrationRequirement(req).ok).toBe(true);
    // The digest is the in-2 requirement digest of the produced document.
    expect(result.desiredStateHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(result.desiredStateHash).toBe(integrationRequirementDigest(req));
  });

  it("is DETERMINISTIC — recompiling identical inputs yields the same doc + hash", () => {
    const a = compileIntegrationRequirement(slackCelebrate, null);
    // A separately-constructed but content-identical behavior (models the
    // provisional-vs-materialized second compilation, which carries no row ids).
    const b = compileIntegrationRequirement(
      behavior({
        persona: "operator",
        title: "celebrate 100 clicks",
        given: "a short link has 99 clicks",
        when: "the 100th click is recorded",
        then: "a celebratory message is posted to our Slack channel",
      }),
      null,
    );
    expect(a.kind).toBe("requirement");
    expect(b.kind).toBe("requirement");
    if (a.kind !== "requirement" || b.kind !== "requirement") return;
    expect(b.requirement).toEqual(a.requirement);
    expect(b.desiredStateHash).toBe(a.desiredStateHash);
  });

  it("compiles an error-capture behavior naming Sentry to errors.capture", () => {
    const result = compileIntegrationRequirement(
      behavior({
        persona: "developer",
        title: "capture runtime exceptions",
        when: "the product throws an unhandled exception",
        then: "the error is reported to Sentry",
      }),
      null,
    );
    expect(result.kind).toBe("requirement");
    if (result.kind !== "requirement") return;
    expect(result.requirement.capability).toBe("errors.capture");
    expect(result.requirement.expectedEffect.provider).toBe("sentry");
    expect(result.requirement.criticality).toBe("best_effort");
    expect(parseIntegrationRequirement(result.requirement).ok).toBe(true);
  });
});

describe("compileIntegrationRequirement — no integration", () => {
  it("returns no_integration for an ordinary product behavior", () => {
    const result = compileIntegrationRequirement(
      behavior({
        persona: "member",
        title: "log in to the dashboard",
        given: "a registered member",
        when: "they submit valid credentials",
        then: "they see their dashboard",
      }),
      null,
    );
    expect(result.kind).toBe("no_integration");
  });
});

describe("compileIntegrationRequirement — NEGATIVE CONTROLS (ambiguous ⇒ no row)", () => {
  it("fails typed when an integration is invoked with no resolvable provider", () => {
    const result = compileIntegrationRequirement(
      behavior({
        persona: "operator",
        title: "notify the team",
        when: "an important event occurs",
        then: "the team is notified somehow",
      }),
      null,
    );
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") return;
    expect(result.issues.some((i) => i.code === "provider_unresolved")).toBe(true);
  });

  it("fails typed when a behavior invokes multiple integration families", () => {
    const result = compileIntegrationRequirement(
      behavior({
        persona: "operator",
        title: "notify and record",
        when: "an event occurs",
        then: "post to Slack and also report the exception to Sentry",
      }),
      null,
    );
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") return;
    expect(result.issues.some((i) => i.code === "multiple_integration_families")).toBe(true);
  });

  it("fails typed when the design contract forbids the only resolvable provider", () => {
    const design: CaptureDesignContract = {
      domain: "saas-web",
      identity: "a link shortener",
      intent: "keep the product simple",
      principles: [],
      constraints: ["Do not use Slack for any product messaging"],
      personas: [],
      behaviors: [],
      dimensions: [],
    };
    const result = compileIntegrationRequirement(slackCelebrate, design);
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") return;
    expect(result.issues.some((i) => i.code === "provider_forbidden_by_design")).toBe(true);
  });
});
