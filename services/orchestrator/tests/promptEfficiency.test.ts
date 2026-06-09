// apex pre-run §7.6 + §7.8 — the demo-honesty + cache-friendly interview prompts:
//   - the demo prompt allows the HONEST SKIP (read-only probes; emit a single
//     `demo-not-exercisable` info finding rather than fabricate failures);
//   - the interview prompt puts the STATIC block FIRST (variable round/answer/capture
//     LAST) and compacts the capture JSON.

import { describe, expect, it } from "vitest";
import { buildDemoRunPrompt } from "../src/engine/workflow/loopStagePrompts.js";
import { buildInterviewPrompt } from "../src/engine/forge/interview/prompt.js";
import { emptyCapture } from "../src/engine/forge/interview/types.js";

describe("buildDemoRunPrompt — honest read-only skip (§7.6)", () => {
  it("acknowledges the read-only sandbox and allows the demo-not-exercisable honest skip", () => {
    const prompt = buildDemoRunPrompt({
      specTitle: "t",
      specDescription: "d",
      acceptanceCriteria: ["c1"],
      baselineSha: "abc123",
    });
    // It no longer mandates the impossible "exercise the app" in a read-only sandbox.
    expect(prompt).toContain("READ-ONLY sandbox");
    expect(prompt).toContain("CANNOT start a server");
    // The honest-skip finding is offered, and fabrication is forbidden.
    expect(prompt).toContain("demo-not-exercisable");
    expect(prompt).toMatch(/NEVER\s+fabricate/u);
  });
});

describe("buildInterviewPrompt — cache-friendly static-first (§7.8)", () => {
  it("puts the static block FIRST and the variable round/answer/capture LAST", () => {
    const capture = emptyCapture();
    const prompt = buildInterviewPrompt({ round: 3, totalRounds: 6, answer: "use rust", capture });
    // The static goal/architecture block precedes the variable round line.
    const staticIdx = prompt.indexOf("running a product vision interview");
    const archIdx = prompt.indexOf("ARCHITECTURE STEP");
    const roundIdx = prompt.indexOf("This is round 3 of ~6");
    expect(staticIdx).toBeGreaterThanOrEqual(0);
    expect(roundIdx).toBeGreaterThan(archIdx);
    expect(archIdx).toBeGreaterThan(staticIdx);
    // The operator's latest answer + capture come after the round line (the tail).
    expect(prompt.indexOf("use rust")).toBeGreaterThan(roundIdx);
  });

  it("compacts the capture JSON (no pretty-print indentation)", () => {
    const capture = emptyCapture();
    const prompt = buildInterviewPrompt({ round: 1, totalRounds: 6, answer: "", capture });
    // Pretty-printed JSON would carry indented `\n  "` sequences; compact JSON does not.
    expect(prompt).toContain(JSON.stringify(capture));
    expect(prompt).not.toContain('{\n  "');
  });
});
