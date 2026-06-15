// Unit proof for the shared SSH transient-retry helper (apex-v35 Part A). A transient
// network blip (ECONNRESET et al.) is RETRIED with bounded backoff; a non-transient error
// (auth) fails immediately; an exhausted transient surfaces LOUD with the real cause.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SSH_TRANSIENT_ATTEMPTS,
  isTransientSshConnectError,
  withSshTransientRetry,
} from "../src/engine/ssh/transientRetry.js";

describe("isTransientSshConnectError", () => {
  it("classifies the transient network errno set as transient (by code AND by message)", () => {
    for (const code of ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EHOSTUNREACH"]) {
      expect(isTransientSshConnectError(Object.assign(new Error("x"), { code }))).toBe(true);
      expect(isTransientSshConnectError(new Error(`read ${code}`))).toBe(true);
    }
  });

  it("does NOT classify auth / host-key / generic errors as transient", () => {
    expect(isTransientSshConnectError(new Error("Handshake failed: host key verification failed"))).toBe(false);
    expect(isTransientSshConnectError(new Error("All configured authentication methods failed"))).toBe(false);
    expect(isTransientSshConnectError(new Error("unparseable fingerprint"))).toBe(false);
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

  it("fails loud after the bounded attempts on a persistent transient (real cause preserved)", async () => {
    let calls = 0;
    await expect(
      withSshTransientRetry(
        async () => {
          calls += 1;
          throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
        },
        { attempts: 3, sleep: async () => {} },
      ),
    ).rejects.toThrow(/ECONNRESET/u);
    expect(calls).toBe(3);
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

  it("defaults to a bounded attempt budget", () => {
    expect(DEFAULT_SSH_TRANSIENT_ATTEMPTS).toBeGreaterThanOrEqual(2);
    expect(DEFAULT_SSH_TRANSIENT_ATTEMPTS).toBeLessThanOrEqual(6);
  });
});
