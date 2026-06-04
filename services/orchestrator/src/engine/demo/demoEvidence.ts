// Demos-as-evidence — the evidence MODEL (design doc § "Native Deployment And
// Demos": demos are first-class behavior evidence tied to the spec's BEHAVIORS, not
// to the provider). This file owns the verifiable artifact a demo produces and the
// provider-AGNOSTIC seam that exercises a surface, kept separate from the engine
// orchestration so the engine file stays under the dependency/line caps.
//
// The unit of demo evidence is PER BEHAVIOR: a demo does not assert "the app
// deployed" — it asserts "behavior X is reachable/exercisable on the live surface,
// here is the captured detail." That per-behavior verdict is what makes a demo
// EVIDENCE (verifiable) rather than narration (prose). The narration layer
// (narration.ts) summarizes this evidence; it never replaces it.
//
// NON-SECRET by construction: a `BehaviorEvidence` carries only the behavior id, the
// surface kind, the outcome, and a human detail string (e.g. "GET /links → HTTP
// 200"). It NEVER carries a token, a credential ref, or a response body — only the
// observable shape of the reach.

import type { DemoSurface } from "../contracts/deployAdapter.js";

/** The outcome of exercising one behavior against a demo surface. */
export type BehaviorEvidenceOutcome = "passed" | "failed";

/**
 * The verifiable evidence one behavior produced against the deployed surface. This
 * is the demo's load-bearing artifact: a per-behavior verdict plus a captured,
 * human-readable detail of WHAT was exercised and what came back. Non-secret —
 * `detail` is an observable shape ("GET /api/links → HTTP 200"), never a body/token.
 */
export interface BehaviorEvidence {
  /** The behavior this evidence is FOR (the spec's behavior row id — ties evidence to behavior). */
  behaviorId: string;
  /** The behavior's human title (carried for the narration summary; non-secret). */
  behaviorTitle: string;
  /** The surface kind the behavior was exercised against (e.g. "web_url"). */
  surfaceKind: DemoSurface["kind"];
  /** Whether the behavior was successfully exercised on the live surface. */
  outcome: BehaviorEvidenceOutcome;
  /** A captured, human-readable detail of the exercise ("GET /links → HTTP 200"). Non-secret. */
  detail: string;
}

/**
 * The route a behavior describes on a web surface — an OPTIONAL relative path the
 * demo exercises against the live URL. A behavior may carry one in its `metadata`
 * (`surfacePath`); absent, the demo exercises the surface ROOT. This is the
 * "behavior's described surface" the per-behavior HTTP reachability check targets.
 * Always a relative path (leading "/"); never an absolute URL (so a behavior can
 * never redirect the probe off the deployed host).
 */
export interface BehaviorSurfacePath {
  /** The relative path the behavior exercises ("/" when none was described). */
  path: string;
}

/**
 * Resolve the relative surface path a behavior describes, from its free-form
 * metadata `surfacePath` field. Only a string that begins with "/" and carries no
 * scheme/host is honored (a behavior can describe a ROUTE on the deployed app, never
 * a different host). Anything else ⇒ the surface root ("/").
 */
export function resolveBehaviorSurfacePath(metadata: Record<string, unknown>): BehaviorSurfacePath {
  const raw = metadata["surfacePath"];
  if (typeof raw === "string" && raw.startsWith("/") && !raw.startsWith("//") && !raw.includes("://")) {
    return { path: raw };
  }
  return { path: "/" };
}

/**
 * The HTTP reach probe a `web_url` surface is exercised over — an injectable seam
 * (scripted in tests; a real `fetch` in production) so the demo engine proves the
 * per-behavior reachability check WITHOUT a live network call. Resolves to the
 * observed HTTP status; a transport-level failure (DNS/connection) throws, which the
 * engine records as a FAILED behavior (the surface did not answer for that behavior).
 *
 * This intentionally MIRRORS the DeployAdapter's `UrlReachabilityProbe` shape but is
 * its OWN contract: a demo reaches a per-behavior ROUTE (url + path), not just the
 * root, and richer exercises (a JSON assertion, a scripted user flow) slot in here as
 * the probe grows — without touching the verify smoke probe.
 */
export interface DemoWebProbe {
  /** Probe `url` for reachability; resolve to the HTTP status the server returned. */
  reach(url: string): Promise<number>;
}

/**
 * Join a `web_url` surface and a behavior's relative path into the concrete URL the
 * demo probes. Trailing/leading slashes are normalized so "https://x/" + "/links"
 * yields "https://x/links" (no double slash, no missing one).
 */
export function joinSurfaceUrl(base: string, path: string): string {
  const trimmedBase = base.endsWith("/") ? base.slice(0, -1) : base;
  const trimmedPath = path.startsWith("/") ? path : `/${path}`;
  return `${trimmedBase}${trimmedPath}`;
}

/**
 * Exercise ONE behavior against a `web_url` surface: probe the behavior's described
 * route (surface url + path) and turn the observed HTTP status into a per-behavior
 * verdict. A 2xx/3xx is PASSED (the behavior's surface is reachable); a 4xx/5xx is
 * FAILED (the route the behavior describes does not serve); a transport failure is
 * FAILED with the error captured. The detail is always the observable shape, never a
 * body — so the evidence is verifiable yet non-secret.
 *
 * Returns evidence — it NEVER throws on a failed reach. A demo records "behavior X
 * failed", it does not abort the whole demo because one behavior's route is down; the
 * point of per-behavior evidence is a HONEST per-behavior verdict.
 */
export async function exerciseWebBehavior(
  probe: DemoWebProbe,
  surfaceUrl: string,
  behavior: { behaviorId: string; behaviorTitle: string; metadata: Record<string, unknown> },
): Promise<BehaviorEvidence> {
  const { path } = resolveBehaviorSurfacePath(behavior.metadata);
  const target = joinSurfaceUrl(surfaceUrl, path);
  const base: Pick<BehaviorEvidence, "behaviorId" | "behaviorTitle" | "surfaceKind"> = {
    behaviorId: behavior.behaviorId,
    behaviorTitle: behavior.behaviorTitle,
    surfaceKind: "web_url",
  };
  try {
    const status = await probe.reach(target);
    const reachable = status >= 200 && status < 400;
    return {
      ...base,
      outcome: reachable ? "passed" : "failed",
      detail: `GET ${path} → HTTP ${String(status)}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...base, outcome: "failed", detail: `GET ${path} → unreachable (${message})` };
  }
}
