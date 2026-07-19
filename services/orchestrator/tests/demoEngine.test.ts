// Demo narration layered ON TOP of the verifiable per-behavior demo EVIDENCE (design doc
// § "Native Deployment And Demos"). The demo produces per-behavior evidence (rv-18: a
// `web_url` behavior's evidence is the REAL rv-11 acceptance verdict via ProofBackedWebDemo;
// the non-web arms via DemoEngine); this narration summarizes that evidence and NEVER
// invents a verdict — a FAILED behavior is folded into the body + showStopperRisks so the
// prose can never claim a behavior the evidence says failed. The DemoEngine dispatch itself
// is covered by demoNonWebArms.test.ts; the proof-backed web demo by proofBackedWebDemo.test.ts.

import { describe, expect, it } from "vitest";
import { templateDemoNarration } from "../src/engine/demo/narration.js";
import type { BehaviorEvidence } from "../src/engine/demo/demoEvidence.js";

describe("narration layered ON TOP of demo evidence", () => {
  const evidence: BehaviorEvidence[] = [
    {
      behaviorId: "beh_links",
      behaviorTitle: "Create a short link",
      surfaceKind: "web_url",
      outcome: "passed",
      detail: "acceptance passed: 2/2 assertions passed",
    },
    {
      behaviorId: "beh_admin",
      behaviorTitle: "View the admin dashboard",
      surfaceKind: "web_url",
      outcome: "failed",
      detail: "acceptance failed_product: 0/1 assertions passed",
    },
  ];

  it("summarizes the verifiable evidence: passed behaviors highlighted, failed → show-stopper risks", () => {
    const answer = templateDemoNarration({
      specTitle: "URL shortener",
      specDescription: "Create and resolve short links.",
      behaviors: [],
      unresolvedRisks: [],
      evidence,
    });
    // The prose reports the live tally, highlights only the PASSED behavior, and turns
    // the FAILED behavior into an honest show-stopper risk.
    expect(answer.headline).toContain("1/2");
    expect(answer.body).toContain("1 passed, 1 failed");
    expect(answer.highlightBehaviorIds).toEqual(["beh_links"]);
    expect(answer.showStopperRisks.join(" ")).toContain("View the admin dashboard");
  });
});
