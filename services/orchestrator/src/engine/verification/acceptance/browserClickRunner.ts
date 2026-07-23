/**
 * rv-26.6: the browser click-runtime SEAM the interactive
 * {@link BrowserAcceptanceSurfaceDriver} drives through. A runner navigates a REAL
 * browser to a served URL and performs N clicks on a target selector, returning one
 * observation per CONFIRMED click.
 *
 * FAIL-LOUD, NEVER FABRICATE: a runner MUST return
 * `{ ok: false }` when the browser cannot launch, the page cannot be reached, the
 * selector is absent, or ANY click of the requested N cannot be confirmed. It MUST
 * NEVER return `{ ok: true }` with fewer observations than requested, and MUST NEVER
 * invent an observation for a click that did not land — a short or fabricated count is
 * exactly the fail-open this node exists to prevent. The driver additionally re-checks
 * the returned count against the request (defence in depth), so a runner that violates
 * this contract is caught, not laundered into a passing verdict.
 *
 * DOCTRINE (timeout-eradication): a click sequence is a bounded operation driven to
 * completion — there is NO wall-clock deadline / retry cap / loop ceiling here. A hung
 * browser is the outer ActivityWatchdog's concern, not a disguised timeout in a runner.
 */

/** One CONFIRMED click. `ordinal` is 1-based and strictly ascending across the run. */
export interface BrowserClickObservation {
  readonly ordinal: number;
}

/** The failure classes a runner distinguishes so the driver maps each to the right fail-closed outcome. */
export type BrowserClickFailureKind = "launch" | "navigate" | "click";

export interface BrowserClickRunInput {
  /** The exact served URL to navigate to (deployed dashboard, or a local fixture in tests). */
  readonly url: string;
  /** The click-target selector supplied by the verification specification. */
  readonly selector: string;
  /** The exact number of clicks to perform; every one must be confirmed or the run fails. */
  readonly clicks: number;
}

export type BrowserClickRunResult =
  | { readonly ok: true; readonly observations: readonly BrowserClickObservation[] }
  | { readonly ok: false; readonly kind: BrowserClickFailureKind; readonly reason: string };

/** Drives a REAL browser: navigate → click the selector N times → one observation per confirmed click. */
export interface BrowserClickRunner {
  runClicks(input: BrowserClickRunInput): Promise<BrowserClickRunResult>;
}

/** Build the strictly-ascending 1..n observation list for a fully-confirmed run. */
export function confirmedClickObservations(count: number): readonly BrowserClickObservation[] {
  const observations: BrowserClickObservation[] = [];
  for (let ordinal = 1; ordinal <= count; ordinal += 1) observations.push({ ordinal });
  return observations;
}
