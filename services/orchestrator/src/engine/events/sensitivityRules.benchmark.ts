import type { SensitivityRule } from "./sensitivity.js";

function rulesFor(eventName: string, entries: ReadonlyArray<[string, SensitivityRule["tag"]]>): SensitivityRule[] {
  return entries.map(([path, tag]) => ({ eventName, path, tag }));
}

const benchmarkStepRules: ReadonlyArray<[string, SensitivityRule["tag"]]> = [
  ["steps[].name", "public"],
  ["steps[].run", "public"],
  ["steps[].exitCode", "public"],
  ["steps[].passed", "public"],
  ["steps[].timedOut", "public"],
  ["steps[].outputTail", "secret"],
];

export const benchmarkSensitivityRules: SensitivityRule[] = [
  ...rulesFor("benchmark.accept.passed", [
    ["cellId", "public"],
    ["trialIndex", "public"],
    ["tier", "public"],
    ["acceptTierHash", "public"],
    ...benchmarkStepRules,
  ]),
  ...rulesFor("benchmark.accept.failed", [
    ["cellId", "public"],
    ["trialIndex", "public"],
    ["tier", "public"],
    ["acceptTierHash", "public"],
    ["failedStep", "public"],
    ["exitCode", "public"],
    ["reason", "public"],
    ...benchmarkStepRules,
  ]),
];
