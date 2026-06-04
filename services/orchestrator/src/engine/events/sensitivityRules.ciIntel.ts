import type { SensitivityRule } from "./sensitivity.js";

// CI-intelligence ingestion (foundation) sensitivity rules, split out of
// sensitivityRules.ts to keep each file under the 500-line cap. The
// `ci.tests.reported` summary carries counts + the head SHA + attempt + the
// test-step exit code — all `public` CI identifiers. No secret value or test
// stdout/stderr is in this event (the persisted per-test names/files are public
// too, mirroring every other CI identifier).
export const ciIntelSensitivityRules: SensitivityRule[] = [
  ...rulesFor("ci.tests.reported", [
    ["headSha", "public"],
    ["attempt", "public"],
    ["total", "public"],
    ["failures", "public"],
    ["flaky", "public"],
    ["testExitCode", "public"],
  ]),
];

function rulesFor(eventName: string, entries: ReadonlyArray<[string, SensitivityRule["tag"]]>): SensitivityRule[] {
  return entries.map(([path, tag]) => ({ eventName, path, tag }));
}
