// INFRASTRUCTURE-FAULT CLASSIFICATION for workspace bootstrap failures. Kept separate from
// the command builder so provisioning and missing-binary remediation remain independently
// readable and each source file stays within Tanren's line bound.

import { failureReason } from "./outputTail.js";
import {
  provisionableBinaries,
  toolBinary,
  TOOLCHAIN_CONTENT_DECLARATION_PATHS,
  TOOLCHAIN_PRESENCE_DECLARATION_PATHS,
  type ToolchainDetection,
  type ToolchainRequirement,
} from "./toolchainDeclarations.js";
import { describeToolchainInEffect, type ToolchainResolution } from "./toolchainEnforcement.js";

// A missing binary named by a shell that could not find it. Covers the two POSIX
// wordings (`sh: 1: pnpm: not found`, `bash: line 1: pnpm: command not found`) and the
// `just`/`make` re-emissions of them. Deliberately generic — no tool is named here.
const MISSING_BINARY_PATTERN = /(?:^|[\s/])([A-Za-z0-9._+-]+): (?:command )?not found/mu;

export function describeRequirements(requirements: readonly ToolchainRequirement[]): string {
  return requirements
    .map(
      (r) => `${r.tool}@${r.spec} (declared in ${r.declaredIn}${r.versionDeclared ? "" : ", version unconstrained"})`,
    )
    .join(", ");
}

/**
 * A deps-install failure that is an INFRASTRUCTURE fault rather than a source defect:
 * the project's bootstrap called a toolchain binary that is not on the runner.
 *
 * WHY THIS CLASS EXISTS. The gate's writer-routing boundary turns a failed deps-install
 * into a P0 finding and dispatches a remediation writer at it. For a genuine scaffold
 * defect (a lockfile that will not install) that is right. For a MISSING BINARY it is an
 * unwinnable loop: no edit to any source file installs a program, so the writer burns
 * budget re-reading the same error until the convergence answerer gives up. Carrying a
 * distinct class lets that boundary decline it and halt legibly instead.
 */
export class WorkspaceToolchainUnavailableError extends Error {
  override readonly name = "WorkspaceToolchainUnavailableError";

  constructor(
    readonly workspacePath: string,
    readonly command: string,
    readonly missingBinary: string,
    readonly exitCode: number | null,
    readonly outputTail: string,
    readonly detection: ToolchainDetection,
    /** What the declared tools ACTUALLY resolved to on this runner, when the run got far
     * enough to verify them. Quoted in the message so a missing-binary halt also answers
     * "…and which versions WERE in effect" without the operator hunting for the line. */
    readonly resolutions: readonly ToolchainResolution[] = [],
  ) {
    super(toolchainUnavailableMessage(command, missingBinary, detection, exitCode, outputTail, resolutions));
  }
}

/**
 * Did the repository DECLARE the tool this binary belongs to, in a declaration Tanren could
 * not honor?
 *
 * `unresolved[].tool` is a MISE TOOL NAME; the shell reports a BINARY. For most entries they
 * are the same string, which is why comparing them directly looked right — but two entries
 * in the catalogue differ, and they are exactly the interesting ones: `rust` → `cargo` and
 * `python` → `python3`. A `rust-toolchain.toml` with `channel = "stable"` whose bootstrap
 * then dies on `cargo: not found` therefore read as "you never declared cargo", and the halt
 * told the operator to declare a tool they had already declared. Resolve the declared tool to
 * its binary before comparing.
 */
function declaresBinary(detection: ToolchainDetection, binary: string): boolean {
  return detection.unresolved.some((u) => u.tool !== undefined && (u.tool === binary || toolBinary(u.tool) === binary));
}

/**
 * Classify a failed deps-install as an infrastructure fault, or return `undefined` to
 * leave it on the writer-routable path.
 *
 * DELIBERATELY NARROW. It fires on exactly two conditions, and only when the shell
 * actually named a missing binary:
 *   - the binary is one Tanren knows how to provision from a declaration (`pnpm`, `uv`,
 *     `go`, `cargo`, …) — so "your bootstrap needs a toolchain nobody declared";
 *   - or the binary is one the repo DID declare and Tanren could NOT honor (an
 *     unresolved declaration naming that tool) — the repo asked, Tanren could not
 *     deliver, and no writer can close that gap either.
 *
 * A missing `vitest`/`tsc`/project script is NOT claimed: those really are scaffold
 * defects the writer can fix by declaring the dependency, and they keep their existing
 * route into the loop.
 */
export function classifyToolchainFault(input: {
  workspacePath: string;
  command: string;
  exitCode: number | null;
  outputTail: string;
  /** Whether the activity watchdog surfaced a no-sign-of-life stall. A STALL IS A LIVENESS
   * FAULT, never a missing-binary one, and the two must not be confused: a guard that
   * stalled can carry a partial `pnpm: not found` written by the project's bootstrap
   * moments before it wedged, and reading that as "the toolchain is not on this runner"
   * both halts a run the writer path could have re-driven and prints `exited unknown`
   * (the exit code of a stall is `null`) instead of saying the command stopped responding. */
  stalled: boolean;
  detection: ToolchainDetection;
  resolutions?: readonly ToolchainResolution[];
}): WorkspaceToolchainUnavailableError | undefined {
  if (input.stalled) {
    return undefined;
  }
  const missing = MISSING_BINARY_PATTERN.exec(input.outputTail)?.[1];
  if (missing === undefined) {
    return undefined;
  }
  const declaredButUnhonored = declaresBinary(input.detection, missing);
  if (!declaredButUnhonored && !provisionableBinaries().includes(missing)) {
    return undefined;
  }
  return new WorkspaceToolchainUnavailableError(
    input.workspacePath,
    input.command,
    missing,
    input.exitCode,
    input.outputTail,
    input.detection,
    input.resolutions ?? [],
  );
}

function toolchainUnavailableMessage(
  command: string,
  missingBinary: string,
  detection: ToolchainDetection,
  exitCode: number | null,
  outputTail: string,
  resolutions: readonly ToolchainResolution[],
): string {
  const declared =
    detection.requirements.length === 0
      ? "nothing — this repository ships no toolchain declaration Tanren recognizes"
      : describeRequirements(detection.requirements);
  const notHonored =
    detection.unresolved.length === 0
      ? ""
      : `\nDeclarations read but NOT honored: ${detection.unresolved
          .map(({ path, reason }) => `${path} ${reason}`)
          .join("; ")}.`;
  return [
    `workspace bootstrap (${command}) needs the '${missingBinary}' binary, which is not available on this runner ` +
      `(${failureReason(exitCode, false)}).`,
    `Tanren provisions a toolchain from what a repository DECLARES: its own mise.toml, or the standard ` +
      `declaration files (${[...TOOLCHAIN_CONTENT_DECLARATION_PATHS, ...TOOLCHAIN_PRESENCE_DECLARATION_PATHS].join(", ")}).`,
    `Detected here: ${declared}.${notHonored}`,
    `Toolchain actually in effect on this runner: ${describeToolchainInEffect(resolutions)}.`,
    declaresBinary(detection, missingBinary)
      ? `'${missingBinary}' WAS declared, but Tanren could not turn that declaration into a provisionable tool. ` +
        `Declare it in a mise.toml, which mise resolves directly, or make it available on the runner image.`
      : `Declare '${missingBinary}' in one of those files — or in a mise.toml — and the run can proceed.`,
    `This is an INFRASTRUCTURE fault, not a source defect: no code change installs a binary, so the run halts ` +
      `here rather than dispatching a remediation writer at an unwinnable loop.${suffix(outputTail)}`,
  ].join("\n");
}

export function suffix(outputTail: string): string {
  return outputTail === "" ? "" : `: ${outputTail}`;
}
