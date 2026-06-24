// Unit proof for the shared SSH transient-retry helper (task #32 — convergence-based,
// UNBOUNDED). A transient network blip (ECONNRESET et al.) is RETRIED unbounded while the
// signal keeps changing (progress); a non-transient error (auth) fails immediately; an
// IDENTICAL signal recurring at the saturated backoff surfaces a
// {@link PersistentSshOutageError} via the convergence detector (intelligent
// non-convergence, never an attempt count).

import { describe, expect, it } from "vitest";
import {
  isTransientSshConnectError,
  PersistentSshOutageError,
  SSH_TRANSIENT_BACKOFF_MS,
  withSshTransientRetry,
} from "../src/engine/ssh/transientRetry.js";

describe("isTransientSshConnectError", () => {
  it("classifies the transient network errno set as transient (by code AND by message)", () => {
    for (const code of ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EHOSTUNREACH"]) {
      expect(isTransientSshConnectError(Object.assign(new Error("x"), { code }))).toBe(true);
      expect(isTransientSshConnectError(new Error(`read ${code}`))).toBe(true);
    }
  });

  it("classifies a CONNECT-ESTABLISHMENT / ssh_failed transport blip as transient (apex v37)", () => {
    // The live v37 finding: a new SSH connection could not establish within the connect
    // window while the runner was momentarily saturated — it recovered seconds later.
    expect(isTransientSshConnectError(new Error("SSH connection failed to establish within 30000ms"))).toBe(true);
    // The `ssh_failed` failure-kind keyword (serialized into the answerer error message).
    expect(
      isTransientSshConnectError(
        new Error(
          'failure={"kind":"ssh_failed","target":"tanren@runner:22","message":"SSH connection failed to establish within 30000ms"}',
        ),
      ),
    ).toBe(true);
    expect(isTransientSshConnectError(new Error("Connection lost before handshake"))).toBe(true);
    expect(isTransientSshConnectError(new Error("connection refused"))).toBe(true);
  });

  it("does NOT classify auth / host-key / generic errors as transient", () => {
    expect(isTransientSshConnectError(new Error("Handshake failed: host key verification failed"))).toBe(false);
    expect(isTransientSshConnectError(new Error("All configured authentication methods failed"))).toBe(false);
    expect(isTransientSshConnectError(new Error("unparseable fingerprint"))).toBe(false);
    // A host-key fingerprint mismatch rides an `ssh_failed` but is a GENUINE security/config
    // failure that never self-heals — it must stay terminal even with the ssh_failed keyword.
    expect(
      isTransientSshConnectError(
        new Error('failure={"kind":"ssh_failed","message":"SSH host key fingerprint mismatch for tanren@runner:22"}'),
      ),
    ).toBe(false);
  });
});

describe("withSshTransientRetry", () => {
  it("retries a transient failure then succeeds", async () => {
    let calls = 0;
    const result = await withSshTransientRetry(
      async () => {
        calls += 1;
        if (calls < 3) {
          throw new Error("read ECONNRESET");
        }
        return "ok";
      },
      { sleep: async () => {} },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("retries UNBOUNDED while the transient signature CHANGES (progress)", async () => {
    // A CHANGING signature is forward motion (the connect is hitting different wobbles, not
    // stuck). The convergence detector treats it as `progress` and the loop continues —
    // there is NO attempt count to exhaust. After 5 mixed transient failures the operation
    // succeeds on the 6th call.
    const transientErrors: ReadonlyArray<Error> = [
      new Error("read ECONNRESET"),
      new Error("connect ECONNREFUSED 127.0.0.1:22"),
      new Error("connect ETIMEDOUT"),
      new Error("SSH connection failed to establish within 30000ms"),
      new Error("EHOSTUNREACH"),
    ];
    let calls = 0;
    const result = await withSshTransientRetry(
      async () => {
        const error = transientErrors[calls];
        calls += 1;
        if (error !== undefined) {
          throw error;
        }
        return "ok";
      },
      { sleep: async () => {} },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(transientErrors.length + 1);
  });

  it("surfaces PersistentSshOutageError LOUD at a SATURATED identical-signal fixed point", async () => {
    // The IDENTICAL transient signal recurring at the saturated backoff with no new
    // information IS the intelligent non-convergence signal — a proven sustained outage.
    // Every call throws the same ECONNRESET (identical signature 'econnreset'); after the
    // curve has saturated the convergence detector classifies the loop as `fixed_point` and
    // the helper surfaces a PersistentSshOutageError carrying the stuck signature.
    let calls = 0;
    let captured: PersistentSshOutageError | undefined;
    try {
      await withSshTransientRetry(
        async () => {
          calls += 1;
          throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
        },
        { sleep: async () => {} },
      );
    } catch (error) {
      if (error instanceof PersistentSshOutageError) {
        captured = error;
      } else {
        throw error;
      }
    }
    expect(captured).toBeDefined();
    expect(captured?.stuckSignature).toBe("econnreset");
    // The convergence loop ran past the saturated curve before surfacing — not at attempt 1
    // (still ramping) but at the saturation threshold + the cycle confirmation.
    expect(captured?.retriesObserved).toBeGreaterThan(SSH_TRANSIENT_BACKOFF_MS.length);
    expect(calls).toBe(captured?.retriesObserved);
  });

  it("does NOT retry a non-transient error — fails on the first attempt", async () => {
    let calls = 0;
    await expect(
      withSshTransientRetry(
        async () => {
          calls += 1;
          throw new Error("host key verification failed");
        },
        { sleep: async () => {} },
      ),
    ).rejects.toThrow(/host key verification failed/u);
    expect(calls).toBe(1);
  });

  it("DEFAULT_SSH_TRANSIENT_ATTEMPTS is gone (the attempt cap is eradicated)", async () => {
    // Compile-time + module-shape check: the attempt-cap constant must NOT be exported.
    // If it ever returns, the retry path has regressed into the bounded-cap doctrine.
    const moduleExports = (await import("../src/engine/ssh/transientRetry.js")) as Record<string, unknown>;
    expect(moduleExports["DEFAULT_SSH_TRANSIENT_ATTEMPTS"]).toBeUndefined();
  });
});
