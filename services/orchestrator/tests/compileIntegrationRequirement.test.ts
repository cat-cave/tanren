// in-5: the deterministic requirement compiler — evidence-based classification,
// determinism/hash-match, and the fail-closed negative controls (no provider ⇒
// no_integration; unsupported provider / unevidenced trigger ⇒ ambiguous). The
// compiler NEVER fabricates a field or a provider's scopes.

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

describe("compileIntegrationRequirement — positive (verified providers)", () => {
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
    // Real Slack scopes/ops — not a generic default.
    expect(req.requiredScopes).toEqual(["chat:write", "channels:history"]);
    expect(req.requiredOperations).toEqual(["chat.postMessage", "conversations.history"]);
    expect(req.trigger.kind).toBe("threshold"); // "100th" ordinal — evidenced
    expect(req.trigger.behaviorKey).toBe("operator::celebrate 100 clicks");
    expect(req.criticality).toBe("release_required");

    expect(parseIntegrationRequirement(req).ok).toBe(true);
    expect(result.desiredStateHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(result.desiredStateHash).toBe(integrationRequirementDigest(req));
  });

  it("is DETERMINISTIC — recompiling identical inputs yields the same doc + hash", () => {
    const a = compileIntegrationRequirement(slackCelebrate, null);
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

  it("compiles an error-capture behavior naming Sentry to errors.capture with real Sentry scopes", () => {
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
    expect(result.requirement.requiredScopes).toEqual(["event:write"]);
    expect(result.requirement.requiredOperations).toEqual(["store.event"]);
    expect(result.requirement.trigger.kind).toBe("event"); // "throws" — evidenced
    expect(result.requirement.criticality).toBe("best_effort");
    expect(parseIntegrationRequirement(result.requirement).ok).toBe(true);
  });
});

describe("compileIntegrationRequirement — no integration (biases toward no-op)", () => {
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

  it("returns no_integration for a plain-UI success message (no external provider)", () => {
    const result = compileIntegrationRequirement(
      behavior({
        persona: "member",
        title: "show a success message",
        when: "the form is submitted",
        then: "a success message is shown to the user",
      }),
      null,
    );
    expect(result.kind).toBe("no_integration");
  });

  it("returns no_integration for an in-app notify with no external provider named", () => {
    const result = compileIntegrationRequirement(
      behavior({
        persona: "member",
        title: "surface validation errors",
        when: "the form has invalid fields",
        then: "notify the user of the validation errors",
      }),
      null,
    );
    expect(result.kind).toBe("no_integration");
  });
});

describe("compileIntegrationRequirement — ADVERSARIAL (ordinary English / over-evidence)", () => {
  it("does NOT classify a bare provider word used as ordinary English", () => {
    expect(
      compileIntegrationRequirement(
        behavior({
          persona: "member",
          title: "stay focused",
          when: "the form is submitted",
          then: "don't slack off and make sure the work gets done",
        }),
        null,
      ).kind,
    ).toBe("no_integration");

    expect(
      compileIntegrationRequirement(
        behavior({
          persona: "operator",
          title: "watch the pipeline",
          when: "a job fails",
          then: "keep a sentry over the process and retry it",
        }),
        null,
      ).kind,
    ).toBe("no_integration");
  });

  it("DOES classify a provider named as an explicit delivery destination", () => {
    const result = compileIntegrationRequirement(
      behavior({
        persona: "operator",
        title: "celebrate closed deals",
        when: "the 100th deal closes",
        then: "post a message to Slack when a deal closes",
      }),
      null,
    );
    expect(result.kind).toBe("requirement");
    if (result.kind !== "requirement") return;
    expect(result.requirement.capability).toBe("messaging.send");
    expect(result.requirement.expectedEffect.provider).toBe("slack");
  });

  it("does NOT read a version number or 'hits' as a threshold", () => {
    const result = compileIntegrationRequirement(
      behavior({
        persona: "operator",
        title: "announce releases",
        given: "API v2 hits production",
        when: "a user clicks the deploy button",
        then: "post a message to our Slack channel",
      }),
      null,
    );
    expect(result.kind).toBe("requirement");
    if (result.kind !== "requirement") return;
    // Evidenced by the click, NOT defaulted to threshold by the "v2"/"hits".
    expect(result.requirement.trigger.kind).toBe("user_action");
  });
});

describe("compileIntegrationRequirement — NEGATIVE CONTROLS (ambiguous ⇒ no row)", () => {
  it("fails typed (unsupported) for a Discord behavior — never Slack scopes", () => {
    const result = compileIntegrationRequirement(
      behavior({
        persona: "operator",
        title: "celebrate 100 clicks",
        given: "a short link has 99 clicks",
        when: "the 100th click is recorded",
        then: "a celebratory message is posted to our Discord channel",
      }),
      null,
    );
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") return;
    expect(result.issues.some((i) => i.code === "provider_unsupported")).toBe(true);
  });

  it("fails typed when the trigger stimulus is unevidenced (no defaulting)", () => {
    const result = compileIntegrationRequirement(
      behavior({
        persona: "operator",
        title: "post to slack",
        when: "stuff changes",
        then: "a message shows up in our Slack channel",
      }),
      null,
    );
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") return;
    expect(result.issues.some((i) => i.code === "trigger_stimulus_unevidenced")).toBe(true);
  });

  it("fails typed when a behavior names providers across multiple families", () => {
    const result = compileIntegrationRequirement(
      behavior({
        persona: "operator",
        title: "notify and record",
        when: "the 100th click is recorded",
        then: "post to Slack and also report the exception to Sentry",
      }),
      null,
    );
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") return;
    expect(result.issues.some((i) => i.code === "multiple_integration_families")).toBe(true);
  });

  it("fails typed when the design contract forbids the only named provider", () => {
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

  it("honors natural constraint phrasing — 'Slack is not allowed' / 'instead of Slack'", () => {
    for (const constraint of ["Slack is not allowed", "Slack is forbidden", "Use email instead of Slack"]) {
      const design: CaptureDesignContract = {
        domain: "saas-web",
        identity: "a link shortener",
        intent: "keep the product simple",
        principles: [],
        constraints: [constraint],
        personas: [],
        behaviors: [],
        dimensions: [],
      };
      const result = compileIntegrationRequirement(slackCelebrate, design);
      expect(result.kind, `constraint: ${constraint}`).toBe("ambiguous");
      if (result.kind !== "ambiguous") continue;
      expect(result.issues.some((i) => i.code === "provider_forbidden_by_design")).toBe(true);
    }
  });
});
