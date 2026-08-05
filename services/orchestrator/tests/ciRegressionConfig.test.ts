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

  it("REFUSES two regression declarations at one lifecycle point", () => {
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
    expect(message).toContain("per_iteration");
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

  it("ALLOWS the same count of declarations spread across DIFFERENT lifecycle points", () => {
    // One per point is fine — each point resolves its own single declaration.
    const parsed = CiConfigV1.safeParse({
      version: 1,
      tiers: {
        fast: [{ name: "one", run: "a", regression: { reportPath: "a.xml" } }],
        slow: [{ name: "t", run: "just test", junitReport: "r.xml", regression: { reportPath: "b.xml" } }],
        merge: [{ name: "m", run: "just test", junitReport: "r.xml" }],
      },
      when: { fast: ["per_iteration"], slow: ["pre_audit"], merge: ["pre_merge"] },
    });
    expect(parsed.success).toBe(true);
  });

  it("allows a regression step on a tier mapped to pre_audit", () => {
    // Only `pre_merge` is the merge authority. A project that wants the transition
    // judgment before its audit as well is making a defensible choice.
    const parsed = CiConfigV1.safeParse({
      version: 1,
      tiers: {
        fast: [{ name: "lint", run: "just lint" }],
        slow: [{ name: "t", run: "just test", junitReport: "r.xml", regression: { reportPath: "r.xml" } }],
        merge: [{ name: "m", run: "just test", junitReport: "r.xml" }],
      },
      when: { fast: ["per_iteration"], slow: ["pre_audit"], merge: ["pre_merge"] },
    });
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
    expect(regressionStepFor(resolveCiConfig(), "per_iteration")).toBeUndefined();
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
