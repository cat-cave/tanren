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

  // apex v32: the prompt MUST NOT steer the writer to bake `--frozen-lockfile`
  // into `just bootstrap` — on a from-scratch greenfield repo that fails the cold
  // bootstrap (ERR_PNPM_NO_LOCKFILE) before any lockfile exists. The bootstrap
  // guidance must instead be a fresh-repo-safe plain install that generates the
  // lockfile.
  it("does NOT suggest a frozen/locked install for `bootstrap` (would brick the cold greenfield bootstrap)", () => {
    const capture = emptyCapture();
    const prompt = buildInterviewPrompt({ round: 2, totalRounds: 6, answer: "use ts/pnpm", capture });
    // No frozen/locked install is RECOMMENDED as the bootstrap example. (`--frozen-lockfile`
    // appears only inside the explicit "do NOT use" warning — assert via a positive-example check.)
    expect(prompt).toContain("`bootstrap`: install/restore deps from a CLEAN checkout");
    expect(prompt).toMatch(/pnpm install['"]? \| ['"]?cargo fetch/u);
    expect(prompt).not.toMatch(/'pnpm install --frozen-lockfile'/u);
    // It steers a FRESH-REPO-SAFE bootstrap that writes the lockfile, and forbids
    // a frozen/locked install on the first scaffold.
    expect(prompt.toLowerCase()).toMatch(/fresh repo|clean checkout|cold checkout/u);
    expect(prompt.toLowerCase()).toMatch(/writes the lockfile|generate the lockfile|generates the lockfile/u);
    expect(prompt.toLowerCase()).toContain("do not use a frozen");
  });
});
