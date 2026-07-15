import { setTimeout as delay } from "node:timers/promises";

/** A repeated structural state is a cycle, including A→B→A alternation. */
export function progressCycleReached(signatures: readonly string[]): boolean {
  if (signatures.length < 2) return false;
  const current = signatures.at(-1)!;
  return signatures.slice(0, -1).includes(current);
}

export async function waitWhileProgressing<T>(options: {
  probe: () => Promise<T>;
  classify: (
    value: T,
  ) => { kind: "ready"; value: T } | { kind: "advancing"; signature: string } | { kind: "terminal"; error: Error };
  signal?: AbortSignal;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<T> {
  const sleep = options.sleep ?? ((ms: number) => delay(ms));
  const interval = options.pollIntervalMs ?? 250;
  const signatures: string[] = [];
  for (;;) {
    if (options.signal?.aborted) throw options.signal.reason;
    const observation = await options.probe();
    const verdict = options.classify(observation);
    if (verdict.kind === "ready") return verdict.value;
    if (verdict.kind === "terminal") throw verdict.error;
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
