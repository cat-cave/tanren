// Architecture grep — PINS the invariant that makes the behavior produce→land binding
// NOT a TOCTOU. An independent cross-model audit (opencode/glm-5.2) flagged a suspected
// produce→land race: the land gate (`merge/behaviorLandGate.ts`, `resolveLandTimeBehaviorGate`)
// reads the RECORDED `behavior_verdicts` for a run and never re-resolves the run's CURRENT
// declared blocking-behavior SET (`spec_behaviors`). IF `spec_behaviors` could gain a required
// behavior between produce (verdicts recorded) and land (gate reads verdicts), the land gate
// would pass on stale verdicts that don't cover the new behavior.
//
// WHY IT IS SAFE (proven here, not by a redundant land-time re-read): a spec's declared
// behavior SET is FROZEN at spec creation, strictly BEFORE any run for that spec can exist —
// so the produce→land window (and even the bootstrap→land window) can NEVER observe a
// `spec_behaviors` mutation. Three structural facts guarantee it, and this test fails loudly
// if any future change breaks one (at which point a land-time SET re-check MUST be added):
//
//   1. `spec_behaviors` is mutated ONLY through `BehaviorStore.linkToSpec` (the sole
//      `INSERT INTO spec_behaviors`) / `unlinkFromSpec` (the sole `DELETE`), in
//      `entities/behaviors.ts`. No other production file writes the table.
//   2. Every `linkToSpec` caller is a LINK-AT-CREATION site — it links the behavior to a spec
//      that the SAME function just minted via `createSpec`/`createSpecOnClient`
//      (`spec_${randomUUID()}`, a pure INSERT — never an upsert onto an existing spec). A run
//      is created from an EXISTING spec (`createQueuedRunFromSpec`), so by the time any run —
//      let alone an in-flight merge run — exists, the spec's behavior SET is already fixed.
//   3. `unlinkFromSpec` (the only removal path) has ZERO production callers, so the SET never
//      shrinks mid-run either.
//
// If someone later adds an add-behavior-to-EXISTING-spec mutator, or wires `unlinkFromSpec`,
// the produce→land window stops being safe-by-construction — this test breaks, forcing a
// land-time SET-coverage re-check in `resolveLandTimeBehaviorGate` (re-resolve the run's
// CURRENT declared blocking behaviors and require the recorded verdicts to cover every one).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const SRC = join(ROOT, "src");
const BEHAVIORS_STORE = "src/engine/entities/behaviors.ts";
const LINK_CALLERS = new Set(["src/engine/forge/interview/deriveBehaviorSpec.ts", "src/engine/forge/tools/write.ts"]);

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...walkTs(full));
      continue;
    }
    if (name.endsWith(".ts") && !name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("spec_behaviors is frozen before any run — the behavior produce→land window is not a TOCTOU", () => {
  const files = walkTs(SRC).map((file) => ({ rel: relative(ROOT, file), text: readFileSync(file, "utf8") }));

  it("mutates spec_behaviors ONLY via linkToSpec/unlinkFromSpec in entities/behaviors.ts", () => {
    const offenders: string[] = [];
    for (const { rel, text } of files) {
      if (rel === BEHAVIORS_STORE) continue;
      if (/INSERT\s+INTO\s+spec_behaviors/iu.test(text)) offenders.push(`${rel}: INSERT INTO spec_behaviors`);
      if (/UPDATE\s+spec_behaviors/iu.test(text)) offenders.push(`${rel}: UPDATE spec_behaviors`);
      if (/DELETE\s+FROM\s+spec_behaviors/iu.test(text)) offenders.push(`${rel}: DELETE FROM spec_behaviors`);
    }
    expect(offenders).toEqual([]);
  });

  it("links behaviors ONLY at spec creation — every linkToSpec caller also mints the spec it links", () => {
    const callers = files.filter(
      ({ rel, text }) => rel !== BEHAVIORS_STORE && /BehaviorStore\.linkToSpec\s*\(/u.test(text),
    );
    // The set of production link sites is exactly the two known link-at-creation callers.
    expect(new Set(callers.map((file) => file.rel))).toEqual(LINK_CALLERS);
    // Each links to a spec the SAME module just created (createSpec / createSpecOnClient), so the
    // link never lands on a pre-existing spec that could already have an in-flight run.
    for (const caller of callers) {
      expect(caller.text, `${caller.rel} must link-at-creation (call createSpec/createSpecOnClient)`).toMatch(
        /\bcreateSpec(OnClient)?\s*\(/u,
      );
    }
  });

  it("has NO production removal path — unlinkFromSpec is never called (the SET never shrinks mid-run)", () => {
    const offenders = files
      .filter(({ rel, text }) => rel !== BEHAVIORS_STORE && /BehaviorStore\.unlinkFromSpec\s*\(/u.test(text))
      .map((file) => file.rel);
    expect(offenders).toEqual([]);
  });
});
