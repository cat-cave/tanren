// Boot-wiring coverage for `startRunWorkspaceReaper` (Codex r5 §2): the reaper must
// reuse the loud `parseSshPort` + `resolveBootedAllocatorKind` parsers, so a
// malformed `TANREN_RUNNER_SSH_PORT` FAILS LOUD (never `Number("not-a-port")` → NaN
// handed to the SSH client) and a typo'd `TANREN_ALLOCATOR_KIND` FAILS LOUD (never a
// silent `!== "static"` miss that quietly disables the reaper — the exact leak this
// module exists to fix). The tick behavior is covered in runWorkspaceReaper.test.ts.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startRunWorkspaceReaper } from "../src/engine/worker/buildRunWorkspaceReaper.js";
import type { CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import type { SecretStore } from "../src/engine/contracts/secretStore.js";

// A pool/ssh/secret set that throws if touched — the boot fail-loud paths must throw
// BEFORE any of these is used (they are only reached by the per-tick thunk, never at
// boot). They double as a no-op set for the "reaper OFF for kind" non-throwing cases.
const SSH = {} as CommandSubstrate;
const SECRETS = {} as SecretStore;
const POOL = {} as never;
const deps = { pool: POOL, secrets: SECRETS, ssh: SSH, identitySecretRef: "ref" };

const KEYS = ["TANREN_ALLOCATOR_KIND", "TANREN_RUNNER_SSH_PORT"] as const;
const SAVED: Record<string, string | undefined> = {};

describe("startRunWorkspaceReaper boot wiring", () => {
  beforeEach(() => {
    for (const key of KEYS) {
      SAVED[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of KEYS) {
      if (SAVED[key] === undefined) delete process.env[key];
      else process.env[key] = SAVED[key];
    }
  });

  it("FAILS LOUD on a malformed reaper SSH port (never a silent NaN)", () => {
    process.env.TANREN_ALLOCATOR_KIND = "static";
    process.env.TANREN_RUNNER_SSH_PORT = "not-a-port";
    expect(() => startRunWorkspaceReaper(deps)).toThrow(/TANREN_RUNNER_SSH_PORT.*not a valid TCP port/su);
  });

  it("FAILS LOUD on an out-of-range reaper SSH port", () => {
    process.env.TANREN_ALLOCATOR_KIND = "static";
    process.env.TANREN_RUNNER_SSH_PORT = "70000";
    expect(() => startRunWorkspaceReaper(deps)).toThrow(/not a valid TCP port/su);
  });

  it("FAILS LOUD on a typo'd allocator kind (never a silent reaper-disable)", () => {
    // A misspelled `static` (here `statik`) is NOT a known kind; the old raw
    // `!== "static"` compare would have silently returned undefined (reaper OFF).
    // The loud enum parser throws instead, so a typo can't quietly disable the reaper.
    process.env.TANREN_ALLOCATOR_KIND = "statik";
    expect(() => startRunWorkspaceReaper(deps)).toThrow(/not a known allocator kind/su);
  });

  it("is OFF (returns undefined, no throw) for a valid non-static kind", () => {
    process.env.TANREN_ALLOCATOR_KIND = "sidecar";
    expect(startRunWorkspaceReaper(deps)).toBeUndefined();
  });
});
