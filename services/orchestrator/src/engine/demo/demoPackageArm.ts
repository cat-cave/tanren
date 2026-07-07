// Demos-as-evidence — the `package` surface EXERCISE ARM (design doc § "Native
// Deployment And Demos"). A `package_release` deploy publishes an installable package
// (npm / PyPI / crates.io / a private registry); the per-behavior exercise proves the
// coordinate RESOLVES on the registry (the same "installability" the DeployAdapter's
// `versionStatus` reads at verify time). The exercise records the observed HTTP status
// + a bounded observable detail (`resolve <coordinate> → HTTP 200`), never a token or a
// registry body.
//
// PROBE SEAM: `DemoPackageProbe` is a tiny injectable HTTP fetch of the registry's
// metadata URL for the coordinate — scripted in tests, a real `fetch` in production.
// The registry URL convention is registry-specific (npm registry vs pypi vs a private
// URL); `registryMetadataUrl` maps the common cases and passes an explicit URL through
// otherwise. A NON-2xx status is a FAILED exercise; a transport-level failure is a
// FAILED exercise with the error captured — the demo never aborts on a per-behavior
// resolve failure (the point of per-behavior evidence is an HONEST per-behavior verdict).
//
// SANDBOXED INSTALL-AND-INVOKE is a legitimate LATER extension (a `CommandSubstrate`
// wiring that shells `npm exec <coordinate> -- <invocation>` in a scratch dir). The base
// arm is HONEST presence-in-registry evidence — real, verifiable, provider-agnostic —
// never a stub. When behaviors declare an `invocation` we surface it as part of the
// detail so the operator + downstream narration can see the intended exercise even
// though the substrate-driven invoke is not the base arm's responsibility.

import type { DemoSurface } from "../contracts/deployAdapter.js";
import type { BehaviorEvidence } from "./demoEvidence.js";

/** The result of a registry-metadata resolve — the observable shape of the package's presence. */
export interface PackageResolveResult {
  /** The HTTP status the registry metadata endpoint returned (200 ⇒ resolvable). */
  status: number;
  /** The concrete metadata URL the probe queried (non-secret; the observable reach). */
  url: string;
}

/**
 * The registry metadata probe the `package` exercise arm runs over. Injectable seam
 * (scripted in tests; the real `fetch` in production) so the arm proves per-behavior
 * exercise WITHOUT a live registry call. Resolves to the HTTP status; a transport-level
 * failure throws, which the arm records as a FAILED behavior (the registry did not
 * answer for that coordinate).
 */
export interface DemoPackageProbe {
  /** Probe the registry metadata for the coordinate; resolve to the observed HTTP status + URL. */
  resolve(input: { registry: string; coordinate: string }): Promise<PackageResolveResult>;
}

/**
 * Parse a coordinate `<name>[@<version>]` (scoped-safe: `@acme/web@1.2.3` → name
 * `@acme/web`, version `1.2.3`). A coordinate without an explicit `@<version>` yields
 * an empty version — the arm then probes the package's latest-metadata endpoint.
 */
export function parsePackageCoordinate(coordinate: string): { name: string; version: string } {
  // Skip a leading `@` (scoped package). The version separator is the LAST `@` (if any).
  const versionAt = coordinate.lastIndexOf("@");
  if (versionAt <= 0) {
    // No `@` beyond position 0 (or none at all) ⇒ no version pin, the whole is the name.
    return { name: coordinate, version: "" };
  }
  return { name: coordinate.slice(0, versionAt), version: coordinate.slice(versionAt + 1) };
}

/**
 * Compose the registry metadata URL for `coordinate` on `registry`. The well-known
 * registries have documented HTTP metadata endpoints; a registry given as an absolute
 * base URL (`https://…`) is passed through with the path appended. A registry that
 * cannot be mapped throws — never a silent fabrication of a URL that will 404.
 */
export function registryMetadataUrl(registry: string, coordinate: string): string {
  const { name, version } = parsePackageCoordinate(coordinate);
  const encodedName = encodeURIComponent(name);
  switch (registry) {
    case "npm":
      // https://registry.npmjs.org/<name>[/<version>] — a version endpoint returns the
      // per-version manifest; a name-only endpoint returns the full package document.
      return version === ""
        ? `https://registry.npmjs.org/${encodedName}`
        : `https://registry.npmjs.org/${encodedName}/${encodeURIComponent(version)}`;
    case "pypi":
      // https://pypi.org/pypi/<name>[/<version>]/json — the JSON-API metadata endpoint.
      return version === ""
        ? `https://pypi.org/pypi/${encodedName}/json`
        : `https://pypi.org/pypi/${encodedName}/${encodeURIComponent(version)}/json`;
    case "crates.io":
      // https://crates.io/api/v1/crates/<name>[/<version>] — the crates.io metadata API.
      return version === ""
        ? `https://crates.io/api/v1/crates/${encodedName}`
        : `https://crates.io/api/v1/crates/${encodedName}/${encodeURIComponent(version)}`;
    default: {
      // A custom registry passed as an absolute URL: <base>/<name>[/<version>].
      if (registry.startsWith("https://") || registry.startsWith("http://")) {
        const base = registry.endsWith("/") ? registry.slice(0, -1) : registry;
        return version === "" ? `${base}/${encodedName}` : `${base}/${encodedName}/${encodeURIComponent(version)}`;
      }
      throw new Error(
        `demoPackageArm: registry '${registry}' has no known metadata URL convention — set the org grant's ` +
          `packageRegistry to 'npm' | 'pypi' | 'crates.io' or a full https:// base URL`,
      );
    }
  }
}

/**
 * The invocation a behavior describes on a package surface — an OPTIONAL command a
 * downstream substrate-driven arm would shell against the installed package (e.g.
 * `--version`, a smoke CLI subcommand). The base arm only SURFACES it in the detail so
 * the operator sees the intended exercise; a follow-up wave layers the substrate call.
 */
function behaviorInvocation(metadata: Record<string, unknown>): string {
  const raw = metadata["invocation"];
  return typeof raw === "string" && raw.length > 0 ? raw : "";
}

/**
 * Exercise ONE behavior against a `package` surface: probe the registry metadata for the
 * coordinate + turn the observed HTTP status into a per-behavior verdict. A 200 is PASSED
 * (the coordinate resolves — the package is installable on the declared registry); a
 * non-2xx is FAILED (the coordinate does not resolve); a transport failure is FAILED with
 * the error captured. The detail is the observable shape (`resolve <coordinate> on
 * <registry> → HTTP 200`, plus the behavior-declared invocation when present), never a
 * body/token.
 *
 * Returns evidence — NEVER throws on a failed resolve. A demo records "behavior X
 * failed", it does not abort the whole demo because one behavior's coordinate did not
 * resolve; the point of per-behavior evidence is an HONEST per-behavior verdict.
 */
export async function exercisePackageBehavior(
  probe: DemoPackageProbe,
  surface: Extract<DemoSurface, { kind: "package" }>,
  behavior: { behaviorId: string; behaviorTitle: string; metadata: Record<string, unknown> },
): Promise<BehaviorEvidence> {
  const invocation = behaviorInvocation(behavior.metadata);
  const invocationSuffix = invocation === "" ? "" : ` (invocation: ${invocation})`;
  const base: Pick<BehaviorEvidence, "behaviorId" | "behaviorTitle" | "surfaceKind"> = {
    behaviorId: behavior.behaviorId,
    behaviorTitle: behavior.behaviorTitle,
    surfaceKind: "package",
  };
  try {
    const result = await probe.resolve({ registry: surface.registry, coordinate: surface.coordinate });
    const resolvable = result.status >= 200 && result.status < 300;
    return {
      ...base,
      outcome: resolvable ? "passed" : "failed",
      detail: `resolve ${surface.coordinate} on ${surface.registry} → HTTP ${String(result.status)}${invocationSuffix}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...base,
      outcome: "failed",
      detail: `resolve ${surface.coordinate} on ${surface.registry} → unreachable (${message})${invocationSuffix}`,
    };
  }
}

/**
 * Build the production `DemoPackageProbe` — a real `fetch` GET of the registry
 * metadata URL, resolving to the observed HTTP status + the concrete URL. A
 * transport-level failure (DNS/connection) propagates as a throw, which the
 * arm records as a FAILED behavior.
 */
export function fetchDemoPackageProbe(fetchImpl: typeof fetch = fetch): DemoPackageProbe {
  return {
    async resolve({ registry, coordinate }): Promise<PackageResolveResult> {
      const url = registryMetadataUrl(registry, coordinate);
      const response = await fetchImpl(url, { method: "GET", redirect: "manual" });
      return { status: response.status, url };
    },
  };
}
