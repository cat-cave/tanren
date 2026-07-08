// Actionable-rejection PARSERS for the F2 runtime-validity smoke, extracted
// from `runtimeValiditySmoke.ts` to keep both files under the 500-line
// architecture cap. Each parser reads the runtime's resolver output (pnpm /
// pip+uv / go / cargo) and picks out the specific unresolvable dep so the
// writer's next rework iteration sees "no matching version for
// vitest@^99.0.0" instead of a generic "install failed".
//
// PURE by design — no imports of `child_process` or any subprocess primitive.
// The live invokers (in `runtimeValiditySmokeLive.ts`, allowlisted by
// `no-host-process-spawn`) call these parsers after collecting stdout/stderr
// from their spawns.

/** Parse pnpm's combined output for the specific unresolved dep, so the writer
 * gets an ACTIONABLE rejection ("no matching version for vitest ^99.0.0") instead
 * of a generic "install failed".
 *
 * pnpm's ERR_PNPM_NO_MATCHING_VERSION message looks like:
 *   ERR_PNPM_NO_MATCHING_VERSION  No matching version found for vitest@^99.0.0
 * Also matches ERR_PNPM_FETCH_404 (dep not found on the registry) and the more
 * general "GET https://…/pkg/-/pkg-x.y.z.tgz: 404" line. */
export function parsePnpmError(output: string): string {
  const noMatch = output.match(/No matching version found for\s+(\S+@\S+)/u);
  if (noMatch !== null) return `no matching version for ${noMatch[1] ?? "unknown"}`;
  const notFound = output.match(/(?:GET.*?)?(?:https?:\/\/\S+\/(\S+?)(?:-|\/)[-.\w]+(?:\.tgz)?)\s*[:\s]+\s*404/u);
  if (notFound !== null) return `package not found on registry: ${notFound[1] ?? "unknown"}`;
  const errCode = output.match(/(ERR_PNPM_[A-Z0-9_]+)/u);
  if (errCode !== null) {
    const firstLine = firstNonEmptyLine(output);
    return `${errCode[1] ?? "ERR_PNPM_UNKNOWN"}: ${firstLine}`;
  }
  const peer = output.match(/unmet peer\s+(\S+@\S+)/u);
  if (peer !== null) return `unmet peer dependency ${peer[1] ?? "unknown"}`;
  return firstNonEmptyLine(output);
}

/** Parse pip's / uv's combined output for the specific unresolved dep.
 *
 * pip's messages look like:
 *   ERROR: Could not find a version that satisfies the requirement fastapi==999.999.999
 *   ERROR: No matching distribution found for fastapi==999.999.999
 * uv's messages look like:
 *   error: Distribution not found at: <url>
 *   × No solution found when resolving dependencies:
 *   ╰─▶ Because there is no version of fastapi==999.999.999 and …
 */
export function parsePipError(output: string): string {
  const couldNot = output.match(/Could not find a version that satisfies the requirement\s+(\S+)/u);
  if (couldNot !== null) return `no matching version for ${couldNot[1] ?? "unknown"}`;
  const noDist = output.match(/No matching distribution found for\s+(\S+)/u);
  if (noDist !== null) return `no matching distribution for ${noDist[1] ?? "unknown"}`;
  const uvNoVer = output.match(/no version of\s+(\S+)/u);
  if (uvNoVer !== null) return `no matching version for ${uvNoVer[1] ?? "unknown"}`;
  const uvNoSolution = output.match(/No solution found when resolving dependencies[\s\S]*?(\S+==\S+)/u);
  if (uvNoSolution !== null) return `unresolvable dependency ${uvNoSolution[1] ?? "unknown"}`;
  return firstNonEmptyLine(output);
}

/** Parse `go mod download` output for the specific unresolved module.
 *
 * go's messages look like:
 *   go: example.com/nope@v9.9.9: reading … 404 Not Found
 *   go: example.com/nope@v9.9.9: unknown revision v9.9.9
 *   go: module example.com/nope: git ls-remote … exit status 128
 */
export function parseGoError(output: string): string {
  const notFound = output.match(/go:\s+(\S+@\S+):[^\n]*404\s+Not Found/u);
  if (notFound !== null) return `module not found: ${notFound[1] ?? "unknown"}`;
  const unknownRev = output.match(/go:\s+(\S+@\S+):[^\n]*unknown revision\s+(\S+)/u);
  if (unknownRev !== null) return `unknown revision ${unknownRev[2] ?? ""} for module ${unknownRev[1] ?? "unknown"}`;
  const noModule = output.match(
    /go:\s+module\s+(\S+):[^\n]*(?:exit status|no matching versions|repository not found)/u,
  );
  if (noModule !== null) return `module resolution failed: ${noModule[1] ?? "unknown"}`;
  const anyGoLine = output
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("go:"));
  if (anyGoLine !== undefined) return anyGoLine;
  return firstNonEmptyLine(output);
}

/** Parse cargo's output for the specific unresolvable crate.
 *
 * cargo's messages look like:
 *   error: failed to select a version for the requirement `foo = "^99.0.0"`
 *   error: no matching package named `foo` found
 *   error: failed to load source for dependency `foo`
 *   error: no matching package for `foo = "^99.0.0"` in the registry `crates-io`
 */
export function parseCargoError(output: string): string {
  const failedSelect = output.match(/failed to select a version for the requirement\s+`([^`]+)`/u);
  if (failedSelect !== null) return `no matching version for ${failedSelect[1] ?? "unknown"}`;
  const noMatchPkg = output.match(/no matching package(?:\s+named)?\s+`([^`]+)`(?:\s+found)?/u);
  if (noMatchPkg !== null) return `no matching package ${noMatchPkg[1] ?? "unknown"}`;
  const failedLoad = output.match(/failed to load source for dependency\s+`([^`]+)`/u);
  if (failedLoad !== null) return `failed to load source for ${failedLoad[1] ?? "unknown"}`;
  const anyErrorLine = output
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("error:"));
  if (anyErrorLine !== undefined) return anyErrorLine;
  return firstNonEmptyLine(output);
}

/** Return the first trimmed non-empty line of the given output, or a stable
 * sentinel when the output is empty. Shared by every parser above. */
export function firstNonEmptyLine(output: string): string {
  const line = output
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ?? "install failed with no output";
}
