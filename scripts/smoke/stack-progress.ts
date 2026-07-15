import { setTimeout as delay } from "node:timers/promises";

/**
 * A repeated structural state is a cycle, including A→B→A alternation. The direct
 * worker/claim/process-fence callers treat ANY repetition of a durable signature
 * as a stall (a fixed point is failure), so this is intentionally sensitive to
 * consecutive duplicates.
 */
export function progressCycleReached(signatures: readonly string[]): boolean {
  if (signatures.length < 2) return false;
  const current = signatures.at(-1)!;
  return signatures.slice(0, -1).includes(current);
}

export async function waitWhileProgressing<T, R>(options: {
  probe: () => Promise<T>;
  classify: (
    value: T,
  ) => { kind: "ready"; value: R } | { kind: "advancing"; signature: string } | { kind: "terminal"; error: Error };
  signal?: AbortSignal;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<R> {
  const sleep = options.sleep ?? ((ms: number) => delay(ms));
  const interval = options.pollIntervalMs ?? 250;
  // Constant-space transition chain: an entry is appended ONLY when the signature
  // CHANGES. A boot/stabilization wait observes the SAME not-ready signature on
  // every poll while a service is still starting — that is waiting, not an
  // oscillation — and must grow nothing here (so an intentionally unbounded
  // fixed-point wait cannot exhaust memory or spend O(n²) in cycle checks). Only
  // a signature that reappears AFTER a different one (A,B,A) is a true structural
  // oscillation; the unchanged `progressCycleReached` over this chain catches it.
  const signatures: string[] = [];
  for (;;) {
    if (options.signal?.aborted) throw options.signal.reason;
    const observation = await options.probe();
    const verdict = options.classify(observation);
    if (verdict.kind === "ready") return verdict.value;
    if (verdict.kind === "terminal") throw verdict.error;
    // Append ONCE per transition: identical-to-previous observations are a still
    // booting service — do not extend the chain and do not cycle-check; just poll
    // again. A differing signature appends, then the cycle check runs over this
    // constant-space chain (never the raw observation stream).
    if (signatures.at(-1) === verdict.signature) {
      await sleep(interval);
      continue;
    }
    signatures.push(verdict.signature);
    if (progressCycleReached(signatures)) {
      throw new Error(`progress cycle at structural signature ${JSON.stringify(verdict.signature)}`);
    }
    await sleep(interval);
  }
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
