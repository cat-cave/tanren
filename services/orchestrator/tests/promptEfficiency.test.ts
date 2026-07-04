// apex pre-run §7.6 + §7.8 — the demo-honesty + cache-friendly interview prompts:
//   - the demo prompt allows the HONEST SKIP (read-only probes; emit a single
//     `demo-not-exercisable` info finding rather than fabricate failures);
//   - the interview prompt puts the STATIC block FIRST (variable round/answer/capture
//     LAST) and compacts the capture JSON.
//
// apex v79 — the SCOPE ROUTING RULE for the triage prompt + the IN-SCOPE FOCUS
// guidance for the auditor prompt. On v79 the writer completed 27 subtasks and the
// gate passed 21× but zero github.pr.created events fired, because the auditor's
// findings ROTATED across 5 iterations (leftover-rails-cta → entrypoint-not-deployed
// → linkly-env-not-consumed → identity-linkly-instead-of-scaffold →
// pnpm-workspace-toolchain-edited). Root cause: the triage prompt kept CROSS-SCOPE
// findings in-spec as `kind: task` when they belonged in a NEW spec (`kind: spec`).
// Fix: (1) triage prompt gains an explicit SCOPE ROUTING RULE that routes clearly
// out-of-band findings OUT as `kind: spec`, so this spec's findings.length can
// reach 0; (2) auditor prompt gains a parallel IN-SCOPE FOCUS block so it either
// omits cross-scope observations or names them out-of-scope explicitly, so triage
// routes them correctly.

import { describe, expect, it } from "vitest";
import { buildDemoRunPrompt, buildTriagePrompt } from "../src/engine/workflow/loopStagePrompts.js";
import { buildAuditorPrompt } from "../src/engine/workflow/answererPrompts.js";
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

describe("buildTriagePrompt — SCOPE ROUTING RULE (apex v79)", () => {
  const ctx = {
    specTitle: "Scaffold identity for a Rails app",
    specDescription: "Rename the scaffold's placeholders to the product identity.",
    findings: [],
    baselineSha: "abc123",
  };

  // On v79 the triage prompt did not explicitly steer the agent to distinguish
  // IN-SCOPE from OUT-OF-SCOPE findings — so cross-scope findings (deploy on a
  // scaffold spec) were kept in-spec as `kind: task`, and each iteration surfaced a
  // NEW out-of-scope finding, the rotating-findings loop that never converged. The
  // SCOPE ROUTING RULE is the primary fix: it must be PRESENT in the prompt.
  it("renders the explicit SCOPE ROUTING RULE header (out-of-scope findings become `kind: spec`)", () => {
    const prompt = buildTriagePrompt(ctx);
    expect(prompt).toContain("SCOPE ROUTING RULE");
  });

  it("names the out-of-scope-becomes-`kind: spec` routing so this spec can converge", () => {
    const prompt = buildTriagePrompt(ctx);
    // The rule must EXPLICITLY route cross-scope work OUT as `kind: spec` — a
    // `kind: task` on an out-of-scope finding is the anti-pattern that killed v79.
    // The routing rule spans wrapped lines in the prompt; the regex tolerates
    // whitespace/newlines between the tokens.
    expect(prompt).toMatch(/cross-scope\s+work OUT as `kind: spec`/u);
    // The rule must NAME the rotating-findings anti-pattern so the agent recognizes
    // the failure mode and applies the routing.
    expect(prompt).toContain("rotating-findings anti-pattern");
    // The rule must call out that the win-condition is findings.length reaching 0
    // → the loop returns "passed" and publishes.
    expect(prompt).toMatch(/findings\.length reach 0/u);
    expect(prompt).toMatch(/return "passed"/u);
  });

  it("cites a concrete cross-scope example the agent can pattern-match on", () => {
    const prompt = buildTriagePrompt(ctx);
    // A concrete example makes the routing rule actionable — the agent must be able
    // to recognize the SHAPE of an out-of-scope finding. v79's canonical example: a
    // deploy concern surfaced by a scaffold spec.
    expect(prompt.toLowerCase()).toContain("deploy");
    expect(prompt.toLowerCase()).toContain("scaffold");
  });
});

describe("buildAuditorPrompt — IN-SCOPE FOCUS (apex v79 parallel guidance)", () => {
  const ctx = {
    specTitle: "Scaffold identity for a Rails app",
    acceptanceCriteria: ["AC1: manifest renamed"],
    baselineSha: "b".repeat(40),
    outputInstructions: ["CLOSING"],
  };

  // The auditor is the UPSTREAM of triage — the parallel fix is to steer the
  // auditor so its findings either OMIT out-of-scope concerns or NAME them
  // out-of-scope explicitly, so downstream triage routes them correctly.
  it("renders the IN-SCOPE FOCUS header naming the apex v79 finding", () => {
    const prompt = buildAuditorPrompt(ctx);
    expect(prompt).toContain("IN-SCOPE FOCUS");
    expect(prompt).toContain("apex v79");
  });

  it("names the cross-scope → new-spec routing (triage's `kind: spec`, not `kind: task`)", () => {
    const prompt = buildAuditorPrompt(ctx);
    // The auditor must be told cross-scope concerns belong in a NEW spec — the same
    // routing target triage uses. Without this, the auditor emits cross-scope
    // findings with generic titles/bodies and triage mis-routes them.
    expect(prompt.toLowerCase()).toContain("cross-scope");
    expect(prompt).toMatch(/`kind: spec`/u);
    expect(prompt).toMatch(/`kind: task`/u);
    expect(prompt.toLowerCase()).toContain("out-of-scope");
  });

  it("names the rotating-findings anti-pattern so the auditor understands the failure mode", () => {
    const prompt = buildAuditorPrompt(ctx);
    // The auditor's block mirrors the triage rule's motivation: rotating findings
    // that never converge to findings.length === 0.
    expect(prompt).toContain("rotating-findings anti-pattern");
    expect(prompt).toMatch(/findings\.length never reaches 0/u);
  });
});
