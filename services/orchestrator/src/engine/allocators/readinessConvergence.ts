// Convergence-based readiness polling for cloud allocators (task #31, critic-arc R1 #2 / R2).
//
// THE BUG (the disguised survivor critic-arc caught after 7 months in production):
// the 5 cloud allocators (DO / AWS EC2 / GCP / Kubernetes / Hetzner) each carried a
// `const deadline = Date.now() + readyTimeoutMs; ... if (Date.now() >= deadline) throw …`
// — a pure wall-clock kill on slow-but-genuinely-progressing provisioning. A droplet
// the cloud was actively bringing up (`new` → `active` → no-IP-yet → IP) past the
// 120s default was killed mid-flight, the orchestrator destroyed it, and the upstream
// run failed even though the cloud was working. The eradication-program lint
// (`scripts/check-architecture-timeouts.mjs`) had not caught the LHS-name binding
// shape (`const deadline = Date.now() + X`); task #31 extends the lint AND ships this
// primitive so every allocator polls on STRUCTURAL signature progress, never a clock.
//
// THE DOCTRINE (feedback_no_timeouts_progress_based, BINDING): "kill on evidence of
// death, never on the passage of time." A working cloud-provisioning loop must run
// UNBOUNDED while the OBSERVABLE STATE is changing — `new` → `active` is forward
// motion, `pending|no-ip` → `running|no-ip` → `running|ip` is forward motion, and
// the loop continues regardless of how long the cloud takes. It surfaces LOUD only
// at intelligent NON-CONVERGENCE: an IDENTICAL non-ready signature recurring past
// the saturation gate (a proven stuck provisioning), via the shared
// `convergenceDetector`. There is NO `readyTimeoutMs`, NO `maxPolls`, NO deadline.
//
// THE STRUCTURE — what the per-allocator caller provides:
//   - `probe()`  — one fetch of the provider's current observable state (the droplet,
//                  the instance, the pod, the server).
//   - `classify(obs)` — turn that observation into `ready` / `advancing` /
//                  `terminal_error` (a provider-reported terminal arm like AWS
//                  `terminated` / `shutting-down` or K8s `Failed`/`Succeeded` — these
//                  fire IMMEDIATELY, never via fixed-point) / `unknown_state` (a NEW
//                  provider status string the allowlist does NOT cover — fail-closed
//                  ratchet, never silently treated as advancing forever).
//   - `signature(obs)` — the STABLE structural identity of this observation: e.g.
//                  `${droplet.status}|${ip-presence}`. A CHANGING signature is
//                  progress (lifecycle advancing); IDENTICAL signatures past the
//                  saturation gate are a proven fixed point (stuck provisioning).
//
// Mirrors `templates/creation/answererRetry.ts#withAnswererRetry` +
// `ssh/transientRetry.ts#withSshTransientRetry` (PR #670) — same convergence detector,
// same saturation gate, same loud-on-fixed-point semantics. The shape is generalized
// so the same primitive serves every cloud allocator (signatures, classifications,
// and terminal arms are per-provider; the loop machinery is shared).

import { assessStructuralProgress, type AttemptSignature } from "../workflow/convergenceDetector.js";

/**
 * The classification a per-allocator `classify()` returns for one observed state.
 * The pollUntilReady loop drives off this:
 *   - `ready` — the provider is up + connectable; return the observation, done.
 *   - `advancing` — a legitimate intermediate lifecycle state (`pending`, `new`,
 *     `running|no-ip`, `Pending`, `PROVISIONING`, `initializing`). The loop continues
 *     UNBOUNDED while these signatures keep CHANGING.
 *   - `terminal_error` — the provider reported a TERMINAL state the loop CANNOT
 *     escape by waiting (AWS `terminated` / `shutting-down`, K8s `Failed` /
 *     `Succeeded`, GCP `operation.error`). Fires IMMEDIATELY — never via the
 *     fixed-point gate (waiting is pointless once the cloud has terminated).
 *   - `unknown_state` — a provider state string the per-allocator allowlist does
 *     NOT recognize (e.g. a brand-new lifecycle phase the provider added). FAIL
 *     CLOSED — surface LOUD as {@link UnknownProvisioningStateError} so an operator
 *     code-updates the classifier rather than silently treating the unknown state
 *     as `advancing` forever.
 */
export type ReadinessClassification<O> =
  | { kind: "ready"; observation: O }
  | { kind: "advancing"; observation: O }
  | { kind: "terminal_error"; reason: string }
  | { kind: "unknown_state"; state: string };

/**
 * Loud terminal classification of a provisioning loop INTELLIGENTLY detected as
 * stuck — the SAME structural signature recurring past the saturation gate with
 * no new information (a proven fixed point: the cloud is wedged, not slow). NOT
 * an attempt cap: it surfaces only when the convergence detector proves the
 * signature is stuck. Carries the stuck signature so the failure is diagnosable.
 *
 * Mirrors `PersistentSshOutageError` / `PersistentAnswererOutageError` shape.
 */
export class PersistentProvisioningOutageError extends Error {
  readonly stuckSignature: string;
  readonly lastObservedState: string;
  readonly probesObserved: number;

  constructor(input: { stuckSignature: string; lastObservedState: string; probesObserved: number; cause?: unknown }) {
    super(
      `provisioning outage: structural signature '${input.stuckSignature}' (last state: ${input.lastObservedState}) ` +
        `recurred past the saturation gate with no progress over ${input.probesObserved} probes — surfacing ` +
        `as a stuck provisioning, not polling a fixed point forever`,
    );
    this.name = "PersistentProvisioningOutageError";
    this.stuckSignature = input.stuckSignature;
    this.lastObservedState = input.lastObservedState;
    this.probesObserved = input.probesObserved;
    if (input.cause !== undefined) {
      this.cause = input.cause;
    }
  }
}

/**
 * Loud terminal classification when a provider returns a state string the
 * per-allocator allowlist does NOT recognize. FAIL CLOSED ratchet: adding a new
 * provider value forces an operator code-change (extend the allocator's
 * `*_PROVISIONING_STATUSES` allowlist) rather than the unknown state being silently
 * treated as `advancing` forever (which would loop infinitely on a state the
 * allocator's classifier was never written for). Distinct from a `terminal_error`
 * (that one names a KNOWN terminal arm the provider documented).
 */
export class UnknownProvisioningStateError extends Error {
  readonly observedState: string;

  constructor(observedState: string) {
    super(
      `provisioning observed an UNKNOWN provider state '${observedState}' — the allocator's status allowlist ` +
        `does not recognize it; fail-closed rather than treat the unknown state as 'advancing' forever. ` +
        `Extend the per-allocator *_PROVISIONING_STATUSES / *_TERMINAL_STATUSES allowlist with this state ` +
        `and classify it.`,
    );
    this.name = "UnknownProvisioningStateError";
    this.observedState = observedState;
  }
}

/**
 * Loud terminal classification when the provider has placed the resource into a
 * documented TERMINAL state mid-provisioning (AWS `terminated`/`shutting-down`,
 * K8s `Failed`/`Succeeded`, GCP `operation.error`, Hetzner `deleting`/`off`).
 * Fires IMMEDIATELY from the classifier — not via the fixed-point gate — because
 * waiting on a terminal arm cannot recover; the cloud has already given up.
 */
export class ProvisioningTerminalStateError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`provisioning entered a terminal state: ${reason}`);
    this.name = "ProvisioningTerminalStateError";
    this.reason = reason;
  }
}

/**
 * The MINIMUM trailing-history length before the convergence detector's fixed-point
 * read may declare a wedge. NOT a poll cap, NOT a give-up budget — a genuinely-
 * advancing signature (a different state token, lifecycle advance, IP appearing) at
 * any probe resets the saturation window and the loop continues UNBOUNDED. The
 * trigger remains signature IDENTITY (the convergence detector's `isCycle` recurrence
 * + `reproducedIdenticalWork` neighbor-identity branches); this floor only guards
 * against the detector firing too eagerly on the first 2–3 provisioning ramp-up
 * ticks where an identical structural signature is normal noise.
 *
 * Mirrors the activity watchdog's `MIN_NON_ADVANCING_NEIGHBOR_REPEATS=2` ratchet:
 * the same idea (a streak floor) applied to a different cadence — provisioning
 * cycles are longer than agent-exec ticks, so the floor sits higher (~15s of
 * identical signature at the default 3s cadence before the detector even considers
 * escalation, well past any single-tick mid-IO-burst false fire).
 *
 * task #43 audit (kept as-is): the original framing of this constant as a "count-
 * based give-up" was a misreading — the helper does NOT return after N stable
 * observations, it ESCALATES to {@link PersistentProvisioningOutageError} (loud,
 * recoverable). The doctrine is "kill on evidence of death"; an identical structural
 * signature across the saturation window IS evidence of a wedge (no new state across
 * the cloud's own state machine ticks). The floor is the saturation primitive, not
 * a wall-clock timeout.
 *
 * arch-allow: timeout-class — STREAK floor on signature identity, not elapsed time.
 */
export const STABLE_CADENCE_FLOOR = 5;

/**
 * Tuning knobs the caller may inject (tests pass a no-wait sleep + an observer).
 */
export interface PollUntilReadyOptions<O> {
  /** Per-allocator classification of the latest observation. */
  classify: (observation: O) => ReadinessClassification<O>;
  /**
   * Per-allocator STRUCTURAL signature — the stable identity the convergence
   * detector reasons over. A CHANGING signature is progress (the lifecycle is
   * advancing); IDENTICAL signatures past the saturation gate are a proven fixed
   * point. Keep this on the OBSERVABLE state (provider status + IP-presence +
   * sorted conditions); avoid wall-clock or counter inputs (would defeat the
   * progress model).
   */
  signature: (observation: O) => string;
  /** Between-probe spacing (cadence). NOT a deadline, NOT a budget. */
  pollIntervalMs: number;
  /** Override the sleep (tests pass a no-wait sleep so the loop runs instantly). */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Observe each probe (tests assert the probe sequence; prod can log). Receives
   * the 1-based probe index and the observed structural signature.
   */
  onProbe?: (info: { probe: number; signature: string }) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    // arch-allow: timeout-class — between-probe SPACING (cadence, not a deadline / not a budget).
    setTimeout(resolve, ms);
  });

/**
 * Has the readiness loop reached a NON-CONVERGENCE fixed point — the SAME structural
 * signature recurring past the saturation gate with no new information? Mirrors
 * `templates/creation/answererRetry.ts#transientFixedPointReached` and
 * `ssh/transientRetry.ts#transientFixedPointReached`. A signature that keeps CHANGING
 * is progress (the lifecycle is still advancing); only an identical signature stuck
 * past the {@link STABLE_CADENCE_FLOOR} is a proven wedged provisioning. PURE: no I/O,
 * no clock, no count beyond the saturation floor (which is a CADENCE FLOOR, not a cap).
 */
function readinessFixedPointReached(signatures: ReadonlyArray<string>): boolean {
  // Until the loop crosses the saturation floor we are still ramping — a few
  // identical reads mid-provisioning are not yet proof of anything.
  if (signatures.length <= STABLE_CADENCE_FLOOR) {
    return false;
  }
  // Project the signatures into AttemptSignature shape: we observe the WORK
  // signature (the structural state) on every probe, so set both `failureSignature`
  // AND `workSignature` to the same string. This lets `assessStructuralProgress`'s
  // immediate-neighbor identity branch (`reproducedIdenticalWork`) fire on
  // byte-identical observed work — the right reading for a structural state probe.
  const history: AttemptSignature[] = signatures.map((sig) => ({
    failureSignature: sig,
    workSignature: sig,
  }));
  return assessStructuralProgress(history) === "fixed_point";
}

/**
 * Convergence-based readiness polling. Run `probe()` on the per-allocator
 * `pollIntervalMs` cadence, route each observation through the per-allocator
 * `classify()`, and:
 *   - `ready` → return the observation.
 *   - `terminal_error` → throw {@link ProvisioningTerminalStateError} IMMEDIATELY
 *     (the existing per-allocator terminal arms — AWS `terminated`/`shutting-down`,
 *     K8s `Failed`/`Succeeded`, GCP operation `error`).
 *   - `unknown_state` → throw {@link UnknownProvisioningStateError} IMMEDIATELY
 *     (fail-closed ratchet: a new provider state forces a code change rather than
 *     silent infinite-loop on an unrecognized advancing state).
 *   - `advancing` → record the structural `signature(observation)` and CONTINUE.
 *     If the latest signature reaches the {@link STABLE_CADENCE_FLOOR} AND the
 *     convergence detector reads `fixed_point`, throw
 *     {@link PersistentProvisioningOutageError} (a stuck provisioning, NOT a
 *     poll cap and NOT an elapsed-time budget). Otherwise sleep `pollIntervalMs`
 *     and loop again.
 *
 * NO `readyTimeoutMs`. NO `maxPolls`. The loop is UNBOUNDED while the structural
 * signature keeps advancing; it surfaces LOUD only on intelligent non-convergence.
 *
 * @typeParam O — the per-allocator observation shape (the droplet, the instance,
 *                the pod, the server). Returned verbatim on `ready` so the caller
 *                can read its IP / IDs / fields directly.
 */
export async function pollUntilReady<O>(probe: () => Promise<O>, opts: PollUntilReadyOptions<O>): Promise<O> {
  const sleep = opts.sleep ?? defaultSleep;
  // The oldest→newest structural signatures observed — the convergence history.
  const signatures: string[] = [];
  for (;;) {
    const observation = await probe();
    const classification = opts.classify(observation);
    if (classification.kind === "ready") {
      return classification.observation;
    }
    if (classification.kind === "terminal_error") {
      // A documented terminal arm (the provider has placed the resource into a
      // state the loop CANNOT recover from by waiting). Fires IMMEDIATELY — never
      // via the fixed-point gate — because waiting on a terminal state cannot help.
      throw new ProvisioningTerminalStateError(classification.reason);
    }
    if (classification.kind === "unknown_state") {
      // A provider state the allocator's status allowlist does not recognize. Fail
      // closed so an operator extends the allowlist rather than the unknown state
      // silently looping forever as if it were `advancing`.
      throw new UnknownProvisioningStateError(classification.state);
    }
    // classification.kind === "advancing" — record + check for non-convergence.
    const signature = opts.signature(observation);
    signatures.push(signature);
    opts.onProbe?.({ probe: signatures.length, signature });
    if (readinessFixedPointReached(signatures)) {
      throw new PersistentProvisioningOutageError({
        stuckSignature: signature,
        lastObservedState: signature,
        probesObserved: signatures.length,
      });
    }
    await sleep(opts.pollIntervalMs);
  }
}
