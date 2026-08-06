// The `regression` step field's CONFIG surface: schema acceptance, the lifecycle lookup,
// and the fail-closed rule that keeps the merge authority out of reach.
import { describe, expect, it } from "vitest";
import { CiConfigV1, regressionStepFor, resolveCiConfig } from "../src/engine/ci/index.js";

function config(extra: { fastStep?: Record<string, unknown>; mergeStep?: Record<string, unknown> } = {}) {
  return {
    version: 1,
    tiers: {
      fast: [{ name: "test-fast", run: "just test", ...extra.fastStep }],
      slow: [{ name: "test-slow", run: "just test", junitReport: "reports/junit.xml" }],
      merge: [{ name: "test-merge", run: "just test", junitReport: "reports/junit.xml", ...extra.mergeStep }],
    },
    when: { fast: ["per_iteration"], slow: ["pre_audit"], merge: ["pre_merge"] },
  };
}

describe("the `regression` step field", () => {
  it("is accepted on a per_iteration tier's step", () => {
    const parsed = CiConfigV1.safeParse(config({ fastStep: { regression: { reportPath: "reports/junit.xml" } } }));
    expect(parsed.success).toBe(true);
  });

  it("is optional — a config without it parses unchanged", () => {
    expect(CiConfigV1.safeParse(config()).success).toBe(true);
  });

  it("rejects an empty reportPath (a path that reads nothing is a silent no-op)", () => {
    const parsed = CiConfigV1.safeParse(config({ fastStep: { regression: { reportPath: "" } } }));
    expect(parsed.success).toBe(false);
  });

  it("rejects unknown keys inside the block", () => {
    const parsed = CiConfigV1.safeParse(config({ fastStep: { regression: { reportPath: "r.xml", minTests: 1 } } }));
    expect(parsed.success).toBe(false);
  });

  it("REFUSES a regression contract on a pre_merge tier — the merge authority is absolute", () => {
    // `.tanren/ci.yml` is repo-sourced and WRITER-EDITABLE. Without this rule a writer
    // that could not get the merge gate green has a one-line, innocuous-looking edit
    // available that makes a red suite mergeable.
    const parsed = CiConfigV1.safeParse(config({ mergeStep: { regression: { reportPath: "reports/junit.xml" } } }));
    expect(parsed.success).toBe(false);
    const message = parsed.success ? "" : parsed.error.issues.map((i) => i.message).join(" ");
    expect(message).toContain("pre_merge");
    expect(message).toContain("test-merge");
  });

  it("still refuses when the pre_merge tier is named something else", () => {
    // The rule keys off the `when` policy, not the tier NAME — renaming the tier must not
    // be an escape hatch.
    const parsed = CiConfigV1.safeParse({
      version: 1,
      tiers: {
        fast: [{ name: "lint", run: "just lint" }],
        slow: [{ name: "t", run: "just test", junitReport: "r.xml" }],
        release: [{ name: "m", run: "just test", junitReport: "r.xml", regression: { reportPath: "r.xml" } }],
      },
      when: { fast: ["per_iteration"], slow: ["pre_audit"], release: ["pre_merge"] },
    });
    expect(parsed.success).toBe(false);
  });

  it("REFUSES two regression declarations in the same run", () => {
    // Only ONE baseline is captured per run, from the first declaration's command. A second
    // step judged against it would read its own tests as never having passed, so a green
    // suite could surface as a mass regression. There is no sensible reconciliation.
    const parsed = CiConfigV1.safeParse({
      version: 1,
      tiers: {
        fast: [
          { name: "backend", run: "just test-py", regression: { reportPath: "py.xml" } },
          { name: "frontend", run: "just test-ts", regression: { reportPath: "ts.xml" } },
        ],
        slow: [{ name: "t", run: "just test", junitReport: "r.xml" }],
        merge: [{ name: "m", run: "just test", junitReport: "r.xml" }],
      },
      when: { fast: ["per_iteration"], slow: ["pre_audit"], merge: ["pre_merge"] },
    });
    expect(parsed.success).toBe(false);
    const message = parsed.success ? "" : parsed.error.issues.map((i) => i.message).join(" ");
    expect(message).toContain("Exactly one is allowed");
    expect(message).toContain("fast.backend");
    expect(message).toContain("fast.frontend");
  });

  it("REFUSES two declarations that meet at a point via DIFFERENT tiers", () => {
    // The rule keys off the `when` policy, so splitting the two across tiers that both map
    // to the same lifecycle point is not an escape hatch.
    const parsed = CiConfigV1.safeParse({
      version: 1,
      tiers: {
        fast: [{ name: "one", run: "a", regression: { reportPath: "a.xml" } }],
        extra: [{ name: "two", run: "b", regression: { reportPath: "b.xml" } }],
        slow: [{ name: "t", run: "just test", junitReport: "r.xml" }],
        merge: [{ name: "m", run: "just test", junitReport: "r.xml" }],
      },
      when: {
        fast: ["per_iteration"],
        extra: ["per_iteration"],
        slow: ["pre_audit"],
        merge: ["pre_merge"],
      },
    });
    expect(parsed.success).toBe(false);
  });

  it("REFUSES declarations spread across different lifecycle points", () => {
    // There is one baseline per RUN, not one per point, so spreading them is not a fix.
    const parsed = CiConfigV1.safeParse({
      version: 1,
      tiers: {
        fast: [{ name: "one", run: "a", regression: { reportPath: "a.xml" } }],
        slow: [{ name: "t", run: "just test", junitReport: "r.xml", regression: { reportPath: "b.xml" } }],
        merge: [{ name: "m", run: "just test", junitReport: "r.xml" }],
      },
      when: { fast: ["per_iteration"], slow: ["pre_audit"], merge: ["pre_merge"] },
    });
    expect(parsed.success).toBe(false);
  });

  it("REFUSES a regression tier mapped to per_iteration AND pre_audit", () => {
    // "Also per_iteration" was treated as good enough, and it is not. `tiersFor` selects a
    // tier at EVERY point it maps to, and `runGateForWhen` forwards the run's ONE baseline to
    // all of them — so this config runs the regression step a second time at pre_audit and
    // judges it on transitions against a baseline captured for the per_iteration run. A suite
    // that is RED at pre_audit passes the evidence-gated check. The config read as correct
    // (it does declare per_iteration) while meaning the thing the rule above forbids.
    const parsed = CiConfigV1.safeParse({
      version: 1,
      tiers: {
        fast: [{ name: "lint", run: "just lint" }],
        slow: [{ name: "t", run: "just test", junitReport: "r.xml", regression: { reportPath: "r.xml" } }],
        merge: [{ name: "m", run: "just test", junitReport: "r.xml" }],
      },
      when: { fast: ["per_iteration"], slow: ["per_iteration", "pre_audit"], merge: ["pre_merge"] },
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain('in ADDITION to \\"per_iteration\\"');
  });

  it("ACCEPTS the one shape the contract supports: per_iteration and nothing else", () => {
    // The positive control, so the rule above cannot be satisfied by refusing everything.
    const parsed = CiConfigV1.safeParse({
      version: 1,
      tiers: {
        fast: [{ name: "lint", run: "just lint" }],
        slow: [{ name: "t", run: "just test", junitReport: "r.xml", regression: { reportPath: "r.xml" } }],
        merge: [{ name: "m", run: "just test", junitReport: "r.xml" }],
      },
      when: { fast: ["per_iteration"], slow: ["per_iteration"], merge: ["pre_merge"] },
    });
    expect(parsed.success).toBe(true);
  });

  it("REFUSES a regression step on a tier mapped only to pre_audit", () => {
    // The single baseline is captured from the `per_iteration` declaration. A pre_audit
    // declaration would be judged against another command's baseline, or none at all —
    // a contract that silently does nothing. Refuse rather than resolve it to something.
    const parsed = CiConfigV1.safeParse({
      version: 1,
      tiers: {
        fast: [{ name: "lint", run: "just lint" }],
        slow: [{ name: "t", run: "just test", junitReport: "r.xml", regression: { reportPath: "r.xml" } }],
        merge: [{ name: "m", run: "just test", junitReport: "r.xml" }],
      },
      when: { fast: ["per_iteration"], slow: ["pre_audit"], merge: ["pre_merge"] },
    });
    expect(parsed.success).toBe(false);
    const message = parsed.success ? "" : parsed.error.issues.map((i) => i.message).join(" ");
    expect(message).toContain("per_iteration");
  });

  it("REFUSES a reportPath that escapes the workspace", () => {
    // This path drives a destructive `rm -f` on the runner and `.tanren/ci.yml` is
    // writer-editable, so containment is enforced where the blast radius is a config error.
    for (const bad of ["../state.json", "/etc/passwd", "reports/../../state.json", "a\\b.xml"]) {
      const parsed = CiConfigV1.safeParse(config({ fastStep: { regression: { reportPath: bad } } }));
      expect(parsed.success, `expected ${bad} to be refused`).toBe(false);
    }
  });

  it("accepts an ordinary nested workspace-relative reportPath", () => {
    const parsed = CiConfigV1.safeParse(config({ fastStep: { regression: { reportPath: "reports/x/junit.xml" } } }));
    expect(parsed.success).toBe(true);
  });

  it("accepts a path containing a dotfile segment that is not `..`", () => {
    const parsed = CiConfigV1.safeParse(config({ fastStep: { regression: { reportPath: ".reports/junit.xml" } } }));
    expect(parsed.success).toBe(true);
  });
});

describe("regressionStepFor", () => {
  const withRegression = CiConfigV1.parse(config({ fastStep: { regression: { reportPath: "reports/junit.xml" } } }));

  it("finds the declared step at the lifecycle point its tier maps to", () => {
    const found = regressionStepFor(withRegression, "per_iteration");
    expect(found?.tier).toBe("fast");
    expect(found?.step.name).toBe("test-fast");
    expect(found?.step.regression?.reportPath).toBe("reports/junit.xml");
  });

  it("returns undefined at a lifecycle point whose tiers declare none", () => {
    expect(regressionStepFor(withRegression, "pre_audit")).toBeUndefined();
  });

  it("returns undefined when the project declares none at all — the zero-cost opt-out", () => {
    expect(regressionStepFor(CiConfigV1.parse(config()), "per_iteration")).toBeUndefined();
  });

  it("returns undefined for the built-in default config", () => {
    // The default must stay byte-identical in behaviour for every repo shipping no ci.yml.
    // `resolveCiConfig` takes a REQUIRED `string | undefined`, so the absent-yaml case has to
    // be passed, not omitted — named here because a bare `undefined` argument trips
    // `unicorn/no-useless-undefined`, and because it says which case is under test.
    const noCiYaml: string | undefined = undefined;
    expect(regressionStepFor(resolveCiConfig(noCiYaml), "per_iteration")).toBeUndefined();
  });

  it("resolves deterministically if two declarations ever reach it — defence in depth", () => {
    // The schema now REFUSES two declarations at one lifecycle point, so this config cannot
    // come from a real `.tanren/ci.yml` (hence the cast past validation). The lookup keeps
    // its first-wins order anyway: a resolver that picked non-deterministically would make
    // the baseline depend on object iteration order, and a validation layer is a bad place
    // to put the ONLY guarantee.
    const unvalidated = {
      version: 1,
      tiers: {
        fast: [
          { name: "one", run: "a", regression: { reportPath: "first.xml" } },
          { name: "two", run: "b", regression: { reportPath: "second.xml" } },
        ],
        slow: [{ name: "t", run: "just test", junitReport: "r.xml" }],
        merge: [{ name: "m", run: "just test", junitReport: "r.xml" }],
      },
      when: { fast: ["per_iteration"], slow: ["pre_audit"], merge: ["pre_merge"] },
    } as unknown as CiConfigV1;
    const found = regressionStepFor(unvalidated, "per_iteration");
    expect(found?.step.name).toBe("one");
    expect(found?.reportPath).toBe("first.xml");
  });
});
