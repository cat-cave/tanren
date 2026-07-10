// EVIDENCE HARVESTER (apex v57 task #64) — the runtime side of the negative-control
// doctrine. Promotes the template-validation insight ("a gate that exits 0 over an
// empty input is a no-op gate") into the runtime gate: every CiStep that declares
// `evidence` is judged on POSITIVE PROOF post-execution, not just process exit code.
//
// The harvester runs AFTER a step's `ssh.run` returns successfully. It reads back
// the declared evidence (a JUnit report, an artifact file, or a stdout pattern
// count) and returns a discriminated verdict. A step that exits 0 but produces
// insufficient evidence is failed by the gate with `failedReason: "evidence_insufficient"`
// — the writer's rework loop gets the diagnosis on iteration 1 instead of after a
// convergence cluster of vacuous greens.
//
// STACK-AGNOSTIC: the harvester never names a test runner / artifact tool / output
// format. It honors the project's declared contract (CiStepEvidence) verbatim. The
// JUnit kind reuses the existing `parseJunitReport` (engine/ci/junit.ts) so the same
// parser feeds both per-test ingest and the evidence verdict.
//
// REUSE: the SSH read path (cat over the workspace, with the absent-vs-empty marker)
// is exported as `readWorkspaceFile` so `ingestGateJunit` shares it (a single SSH
// read primitive, no duplication).

import type { CiStepEvidence } from "../../ci/index.js";
import { type JunitReport, parseJunitReport } from "../../ci/junit.js";
import type { RunnerHandle } from "../../contracts/allocator.js";
import type { CommandSubstrate } from "../../contracts/commandSubstrate.js";
import { quoteSshShellArg } from "../../ssh/command.js";
import { outputOnlyWatchdog } from "../../ssh/activityWatchdog.js";

// The marker the workspace-file read emits when the requested file does not exist.
// Lets a single successful SSH read distinguish "file absent" (marker, no body)
// from "file present but empty" (body is whitespace) — no second stat round-trip.
export const TANREN_FILE_ABSENT_MARKER = "__TANREN_FILE_ABSENT__";

// The marker the artifact STAT emits when the path does not exist at all. Distinct
// from the file-read marker so the two probes never alias each other.
export const TANREN_ARTIFACT_ABSENT_MARKER = "__TANREN_ARTIFACT_ABSENT__";

// Why a workspace file could not be read. Mirrors `ingestGateJunit`'s discrimination.
export type FileAbsence = "absent" | "read_failed" | "empty";

export type WorkspaceFileRead =
  | { present: true; contents: string; bytes: number }
  | { present: false; reason: FileAbsence };

// The result of an artifact STAT (a build-output presence probe). Unlike the
// file-read primitive, the artifact path may be a FILE **or** a DIRECTORY (a `tsc`
// `dist/` tree, a `reports/mutation` report dir). Presence is measured in total
// bytes of regular-file content at/under the path; an empty file or empty directory
// is `empty` (a build that emitted nothing), never `present`.
export type WorkspaceArtifactStat = { present: true; bytes: number } | { present: false; reason: FileAbsence };

export interface HarvesterDeps {
  ssh: CommandSubstrate;
  target: RunnerHandle;
  workspacePath: string;
}

/**
 * `cat` a workspace-relative file over SSH and return a discriminated read result.
 * The `present` branch carries the raw bytes (so a JUnit XML body is parseable) AND
 * a byte count (so the artifact-evidence kind can check `minBytes` without a second
 * stat). This is the single SSH primitive the harvester + ingest both reuse.
 */
export async function readWorkspaceFile(deps: HarvesterDeps, relPath: string): Promise<WorkspaceFileRead> {
  const path = `${deps.workspacePath.replace(/\/+$/u, "")}/${relPath.replace(/^\/+/u, "")}`;
  // The marker lets us distinguish "file absent" (marker, no body) from "file present
  // but empty" (body is whitespace) — both off a single successful SSH read.
  const result = await deps.ssh.run(deps.target, {
    command:
      `if [ -f ${quoteSshShellArg(path)} ]; then cat ${quoteSshShellArg(path)}; ` +
      `else echo ${TANREN_FILE_ABSENT_MARKER}; fi`,
    // INFRA report read: output-driven watchdog, no wall-clock kill.
    watchdog: outputOnlyWatchdog(),
  });
  if (result.failure !== undefined || result.stalled === true || result.exitCode !== 0) {
    return { present: false, reason: "read_failed" };
  }
  const trimmed = result.stdout.trim();
  if (trimmed === "" || trimmed === TANREN_FILE_ABSENT_MARKER) {
    return { present: false, reason: trimmed === "" ? "empty" : "absent" };
  }
  return { present: true, contents: result.stdout, bytes: Buffer.byteLength(result.stdout, "utf8") };
}

/**
 * STAT a workspace-relative ARTIFACT path over SSH and return a discriminated
 * presence verdict. The artifact contract (CiStepEvidence `kind: "artifact"`) asserts
 * the build WROTE output at `path` — but a build output is frequently a DIRECTORY (a
 * `tsc -p tsconfig.build.json` `dist/` tree, a `reports/mutation` report dir), NOT a
 * single file. A plain `[ -f ]` file test reports a directory as ABSENT — the exact
 * false-negative that halted apex v89 (the build emitted `dist/` with `demo.js` et al,
 * yet the artifact probe's `-f dist` test failed for the directory → `artifact_absent`
 * at merge time). So this probe handles BOTH shapes:
 *   - a regular FILE      → its byte size (`wc -c`);
 *   - a DIRECTORY         → the SUM of regular-file bytes under it (recursively);
 *   - absent (`! -e`)     → the absent marker (`reason: "absent"`);
 *   - zero bytes          → `reason: "empty"` (an empty file OR a directory with no
 *                           file content — a build that produced nothing).
 * STACK-AGNOSTIC: it names no artifact tool/format; it only measures presence+size.
 */
export async function statWorkspaceArtifact(deps: HarvesterDeps, relPath: string): Promise<WorkspaceArtifactStat> {
  const path = `${deps.workspacePath.replace(/\/+$/u, "")}/${relPath.replace(/^\/+/u, "")}`;
  const p = quoteSshShellArg(path);
  const result = await deps.ssh.run(deps.target, {
    // File-or-directory presence + total content bytes, in ONE round-trip. A directory
    // sums its regular files' bytes via `find … -type f -exec cat + | wc -c` (POSIX;
    // no GNU-only flags). An absent path echoes the marker; anything else is a byte
    // count (possibly 0 → empty).
    command:
      `if [ ! -e ${p} ]; then echo ${TANREN_ARTIFACT_ABSENT_MARKER}; ` +
      `elif [ -f ${p} ]; then wc -c < ${p}; ` +
      `elif [ -d ${p} ]; then find ${p} -type f -exec cat {} + 2>/dev/null | wc -c; ` +
      `else echo ${TANREN_ARTIFACT_ABSENT_MARKER}; fi`,
    // INFRA stat read: output-driven watchdog, no wall-clock kill.
    watchdog: outputOnlyWatchdog(),
  });
  if (result.failure !== undefined || result.stalled === true || result.exitCode !== 0) {
    return { present: false, reason: "read_failed" };
  }
  const trimmed = result.stdout.trim();
  if (trimmed === TANREN_ARTIFACT_ABSENT_MARKER) {
    return { present: false, reason: "absent" };
  }
  const bytes = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(bytes)) {
    return { present: false, reason: "read_failed" };
  }
  if (bytes === 0) {
    return { present: false, reason: "empty" };
  }
  return { present: true, bytes };
}

// Why a step's evidence is insufficient. Discriminated so the gate.failed payload
// names the actual cause — the writer's directive can be precise ("0 of 1 required
// tests ran") instead of "evidence missing".
export type EvidenceInsufficiency =
  | "junit_missing"
  | "junit_zero_tests"
  | "junit_below_threshold"
  | "artifact_absent"
  | "artifact_too_small"
  | "stdout_count_below_threshold";

export type EvidenceVerdict =
  | {
      sufficient: true;
      kind: CiStepEvidence["kind"];
      observed: Record<string, number>;
      required: Record<string, number>;
    }
  | {
      sufficient: false;
      kind: CiStepEvidence["kind"];
      reason: EvidenceInsufficiency;
      observed: Record<string, unknown>;
      required: Record<string, unknown>;
    };

/**
 * The harvester's full output: the discriminated verdict + (junit only) the parsed
 * JUnit report. The parsed report is exposed as a SIDE CHANNEL — never in the event
 * payload (per-test rows are huge; only the summary lands on `gate.failed`/`gate.passed`)
 * but reused by `ingestGateJunit` so the per-test ingest does not re-read + re-parse
 * the same file. Absent on artifact / stdout-count / on junit_missing.
 */
export interface HarvestResult {
  verdict: EvidenceVerdict;
  /** Set ONLY when the evidence kind is `junit` AND the report was readable + parsed. */
  parsedJunitReport?: JunitReport;
}

/**
 * Harvest a step's declared evidence after the step has run. The caller MUST only
 * invoke this when the step's process exit was 0 (a nonzero exit already fails the
 * step). The verdict carries the observed-vs-required counts on BOTH branches so
 * the gate event payload can record the diagnosis even on a pass.
 *
 * - `kind: "junit"`         — read the report at `reportPath`, parse it, assert
 *                             `report.total >= minTests`. Three failure shapes:
 *                             `junit_missing` (absent/unreadable/empty),
 *                             `junit_zero_tests` (parsed, but `total === 0`),
 *                             `junit_below_threshold` (parsed, but `total < minTests`).
 *                             The parsed report is returned alongside the verdict so
 *                             `ingestGateJunit` reuses it (no double-read over SSH).
 * - `kind: "artifact"`      — stat the path; insufficient if absent or smaller than
 *                             `minBytes` (when given).
 * - `kind: "stdout-count"`  — regex `pattern` against the step's captured stdout;
 *                             insufficient if match count < `min`.
 *
 * STACK-AGNOSTIC: the harvester names no runner / artifact tool / format. It honors
 * the project's declared `evidence` shape verbatim.
 */
export async function harvestStepEvidence(
  deps: HarvesterDeps,
  evidence: CiStepEvidence,
  stepStdout: string,
): Promise<HarvestResult> {
  switch (evidence.kind) {
    case "junit":
      return harvestJunit(deps, evidence);
    case "artifact":
      return { verdict: await harvestArtifact(deps, evidence) };
    case "stdout-count":
      return { verdict: harvestStdoutCount(evidence, stepStdout) };
    default: {
      // Exhaustive: the discriminated union covers every kind above. A future kind
      // that omits its case is a TS error here, not a runtime hole.
      const exhaustive: never = evidence;
      throw new Error(`unhandled evidence kind: ${(exhaustive as { kind: string }).kind}`);
    }
  }
}

async function harvestJunit(
  deps: HarvesterDeps,
  evidence: Extract<CiStepEvidence, { kind: "junit" }>,
): Promise<HarvestResult> {
  const required = { minTests: evidence.minTests };
  const read = await readWorkspaceFile(deps, evidence.reportPath);
  if (!read.present) {
    return {
      verdict: {
        sufficient: false,
        kind: "junit",
        reason: "junit_missing",
        observed: { reportPath: evidence.reportPath, readReason: read.reason },
        required: { ...required, reportPath: evidence.reportPath },
      },
    };
  }
  // A genuinely-malformed report throws from parseJunitReport — the loud-reject contract.
  // We let it propagate; the gate caller catches it as a step-evaluation error (the
  // step is judged FAILED because the evidence cannot be parsed).
  const report = parseJunitReport(read.contents);
  if (report.total === 0) {
    return {
      verdict: {
        sufficient: false,
        kind: "junit",
        reason: "junit_zero_tests",
        observed: { total: 0 },
        required,
      },
      parsedJunitReport: report,
    };
  }
  if (report.total < evidence.minTests) {
    return {
      verdict: {
        sufficient: false,
        kind: "junit",
        reason: "junit_below_threshold",
        observed: { total: report.total },
        required,
      },
      parsedJunitReport: report,
    };
  }
  return {
    verdict: {
      sufficient: true,
      kind: "junit",
      observed: { total: report.total, failures: report.failures },
      required,
    },
    parsedJunitReport: report,
  };
}

async function harvestArtifact(
  deps: HarvesterDeps,
  evidence: Extract<CiStepEvidence, { kind: "artifact" }>,
): Promise<EvidenceVerdict> {
  const required: Record<string, number | string> = { path: evidence.path };
  if (evidence.minBytes !== undefined) required["minBytes"] = evidence.minBytes;
  // Stat the artifact path — handles a FILE or a DIRECTORY build output (the `dist/`
  // false-negative fix). A file-only `[ -f ]` read would report the `dist` directory
  // as absent even though the build wrote it.
  const stat = await statWorkspaceArtifact(deps, evidence.path);
  if (!stat.present) {
    return {
      sufficient: false,
      kind: "artifact",
      reason: "artifact_absent",
      observed: { path: evidence.path, readReason: stat.reason },
      required,
    };
  }
  if (evidence.minBytes !== undefined && stat.bytes < evidence.minBytes) {
    return {
      sufficient: false,
      kind: "artifact",
      reason: "artifact_too_small",
      observed: { bytes: stat.bytes },
      required,
    };
  }
  return {
    sufficient: true,
    kind: "artifact",
    observed: { bytes: stat.bytes },
    required: { minBytes: evidence.minBytes ?? 0 },
  };
}

function harvestStdoutCount(
  evidence: Extract<CiStepEvidence, { kind: "stdout-count" }>,
  stepStdout: string,
): EvidenceVerdict {
  const required = { min: evidence.min };
  // The project's declared pattern is a regex source. We compile with the `u` + `g`
  // flags so multi-byte matches are correct and `matchAll` enumerates every hit.
  // A malformed pattern is the project's bug — throw loudly so the writer fixes it.
  const regex = new RegExp(evidence.pattern, "gu");
  const matches = [...stepStdout.matchAll(regex)];
  if (matches.length < evidence.min) {
    return {
      sufficient: false,
      kind: "stdout-count",
      reason: "stdout_count_below_threshold",
      observed: { matches: matches.length, pattern: evidence.pattern },
      required: { ...required, pattern: evidence.pattern },
    };
  }
  return {
    sufficient: true,
    kind: "stdout-count",
    observed: { matches: matches.length },
    required,
  };
}
