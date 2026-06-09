// no_silent_fallbacks — codex rotated-auth write-back.
//
// Codex rotates its access/refresh tokens DURING a run; persisting the new bundle is
// how the NEXT run authenticates. A failed store is NOT benign — it leaves the stale
// (possibly revoked) refresh token in place, a real credential corruption. The former
// best-effort swallow now LOGS LOUD and PROPAGATES.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import type { SecretStore } from "../src/engine/contracts/secretStore.js";
import { persistRefreshedCodexAuth } from "../src/engine/providers/codex.js";

const TARGET = { id: "runner_test" } as unknown as RunnerHandle;
const VALID_AUTH_JSON = JSON.stringify({ OPENAI_API_KEY: "sk-rotated" });

// An ssh substrate that returns the rotated auth.json on the `cat ... auth.json` read.
function fakeSshReturning(authJson: string): CommandSubstrate {
  return {
    run: async (): Promise<CommandResult> => ({
      exitCode: 0,
      stdout: authJson,
      stderr: "",
      timedOut: false,
    }),
  };
}

// A secret store whose `put` (the store write) throws — the rotation-persist failure.
// `get` is unused by the code under test, so only `put` is defined (partial cast).
function failingSecretStore(): SecretStore {
  return {
    put: async () => {
      throw new Error("vault put rejected");
    },
  } as unknown as SecretStore;
}

// A secret store that accepts the put (the happy path).
function recordingSecretStore() {
  const puts: Array<{ ref: string; value: string }> = [];
  const store = {
    put: async (secret: { ref: string; value: string }) => {
      puts.push(secret);
    },
  } as unknown as SecretStore;
  return { store, puts };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("persistRefreshedCodexAuth — a store failure PROPAGATES (never swallowed)", () => {
  it("logs LOUD and THROWS when the auth-bundle store fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      persistRefreshedCodexAuth({
        secrets: failingSecretStore(),
        ssh: fakeSshReturning(VALID_AUTH_JSON),
        target: TARGET,
        ref: "credential/codex/test",
        codexHome: "/home/codex/.codex",
        timeoutMs: 30_000,
      }),
    ).rejects.toThrow(/vault put rejected/u);
    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0]?.join(" ")).toMatch(/rotated auth bundle/iu);
  });

  it("persists the rotated bundle on the happy path (no throw)", async () => {
    const { store, puts } = recordingSecretStore();
    await persistRefreshedCodexAuth({
      secrets: store,
      ssh: fakeSshReturning(VALID_AUTH_JSON),
      target: TARGET,
      ref: "credential/codex/test",
      codexHome: "/home/codex/.codex",
      timeoutMs: 30_000,
    });
    expect(puts).toHaveLength(1);
    expect(puts[0]?.ref).toBe("credential/codex/test");
  });
});
