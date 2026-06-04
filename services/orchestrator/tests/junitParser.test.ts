// CI-intelligence ingestion (foundation): the JUnit XML parser. Proves per-test
// outcome/duration/retry extraction across the runner subset Tanren ingests, the
// stable test id, the Surefire intra-run flaky/rerun capture, and — critically —
// that malformed input is a LOUD reject (never a silent drop or a mis-parse that
// would let a broken report read as all-green).

import { describe, expect, it } from "vitest";
import { JunitParseError, parseJunitReport } from "../src/engine/ci/junit.js";

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="vitest" tests="5" failures="1" errors="1">
  <testsuite name="src/math.test.ts" tests="4">
    <testcase classname="add" name="adds two numbers" time="0.012" file="src/math.test.ts"/>
    <testcase classname="add" name="adds negatives" time="0.5" file="src/math.test.ts">
      <failure message="expected 0 to be -2">AssertionError</failure>
    </testcase>
    <testcase classname="divide" name="throws on zero" time="0.003">
      <error message="boom">RuntimeError</error>
    </testcase>
    <testcase classname="divide" name="todo case" time="0">
      <skipped/>
    </testcase>
  </testsuite>
  <testsuite name="src/io.test.ts" tests="1">
    <testcase classname="io" name="flaky read" time="0.2">
      <flakyFailure message="first attempt failed">timeout</flakyFailure>
    </testcase>
  </testsuite>
</testsuites>
`;

describe("parseJunitReport", () => {
  it("parses per-test outcomes, durations, file, suite, and stable test id", () => {
    const report = parseJunitReport(SAMPLE);
    expect(report.total).toBe(5);
    expect(report.failures).toBe(2);

    const byId = new Map(report.results.map((r) => [r.testId, r]));

    const passed = byId.get("add.adds two numbers");
    expect(passed).toMatchObject({
      outcome: "passed",
      durationMs: 12,
      file: "src/math.test.ts",
      suite: "src/math.test.ts",
      retries: 0,
      flakyFailure: false,
    });

    expect(byId.get("add.adds negatives")?.outcome).toBe("failed");
    expect(byId.get("add.adds negatives")?.durationMs).toBe(500);
    expect(byId.get("divide.throws on zero")?.outcome).toBe("error");
    expect(byId.get("divide.todo case")?.outcome).toBe("skipped");
  });

  it("captures a Surefire flakyFailure (fail-then-pass within one run)", () => {
    const report = parseJunitReport(SAMPLE);
    const flaky = report.results.find((r) => r.testId === "io.flaky read");
    // The case PASSES (flakyFailure ⇒ it eventually passed) but is flagged + counts a retry.
    expect(flaky).toMatchObject({ outcome: "passed", flakyFailure: true, retries: 1, suite: "src/io.test.ts" });
  });

  it("counts multiple rerun children as retries", () => {
    const xml = `<testsuite name="s"><testcase classname="c" name="t" time="1">
      <rerunFailure>one</rerunFailure><rerunFailure>two</rerunFailure>
    </testcase></testsuite>`;
    const report = parseJunitReport(xml);
    expect(report.results[0]).toMatchObject({ retries: 2, flakyFailure: false, outcome: "passed" });
  });

  it("falls back to the bare name when no classname is present", () => {
    const xml = `<testsuite name="s"><testcase name="bare test" time="0.1"/></testsuite>`;
    expect(parseJunitReport(xml).results[0]?.testId).toBe("bare test");
  });

  it("accepts a single <testsuite> root and null file when absent", () => {
    const xml = `<testsuite name="solo"><testcase classname="a" name="b" time="0.05"/></testsuite>`;
    const report = parseJunitReport(xml);
    expect(report.results[0]).toMatchObject({ testId: "a.b", file: null, durationMs: 50 });
  });

  it("LOUDLY rejects malformed XML (unclosed tag)", () => {
    const xml = `<testsuites><testsuite name="s"><testcase name="x" time="0.1"></testsuite></testsuites>`;
    expect(() => parseJunitReport(xml)).toThrow(JunitParseError);
  });

  it("LOUDLY rejects mismatched closing tags", () => {
    expect(() => parseJunitReport(`<testsuites></testsuite>`)).toThrow(JunitParseError);
  });

  it("LOUDLY rejects an empty report body", () => {
    expect(() => parseJunitReport("   ")).toThrow(JunitParseError);
  });

  it("LOUDLY rejects a wrong root element", () => {
    expect(() => parseJunitReport(`<results><testcase name="x"/></results>`)).toThrow(JunitParseError);
  });

  it("LOUDLY rejects a testcase with no name", () => {
    expect(() => parseJunitReport(`<testsuite name="s"><testcase time="0.1"/></testsuite>`)).toThrow(JunitParseError);
  });

  it("LOUDLY rejects a negative / non-numeric time", () => {
    expect(() => parseJunitReport(`<testsuite name="s"><testcase name="x" time="-1"/></testsuite>`)).toThrow(
      JunitParseError,
    );
    expect(() => parseJunitReport(`<testsuite name="s"><testcase name="x" time="abc"/></testsuite>`)).toThrow(
      JunitParseError,
    );
  });

  it("decodes XML entities in names", () => {
    const xml = `<testsuite name="s"><testcase classname="c" name="a &amp; b &lt; c" time="0.1"/></testsuite>`;
    expect(parseJunitReport(xml).results[0]?.testId).toBe("c.a & b < c");
  });
});
