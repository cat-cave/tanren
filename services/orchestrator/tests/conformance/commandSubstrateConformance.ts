// Seam conformance suite for the CommandSubstrate contract
// (engine/contracts/commandSubstrate.ts). A reusable behavior spec invoked once
// per implementation via `describeCommandSubstrateConformance`. It asserts the
// CONTRACT only — that `run()` returns a well-formed CommandResult and reports a
// transport failure IN-BAND (via `result.failure`) rather than throwing — never
// an impl's private transport. SSH is the one concrete backend today; a native-
// exec backend gets contract coverage by adding one harness block.
import { describe, expect, it } from "vitest";
import type { RunnerHandle, SshRunnerHandle } from "../../src/engine/contracts/allocator.js";
import type { CommandSubstrate, RunnerCommand } from "../../src/engine/contracts/commandSubstrate.js";

export interface CommandSubstrateConformanceHarness {
  // A fresh substrate under test.
  make(): CommandSubstrate;
  // A handle the substrate accepts. SSH impls return their SshRunnerHandle.
  handle(): RunnerHandle;
}

// A failure-mode harness for impls that can be forced to report a transport
// failure IN-BAND (result.failure set). Passed to the separate
// `describeCommandSubstrateFailureConformance` (mirrors the allocator suite's
// split) so the success spec stays unconditional.
export interface CommandSubstrateFailureHarness {
  makeFailing(): { substrate: CommandSubstrate; handle: RunnerHandle };
}

const ECHO: RunnerCommand = { command: "echo conformance" };

export function describeCommandSubstrateConformance(label: string, harness: CommandSubstrateConformanceHarness): void {
  describe(`CommandSubstrate conformance: ${label}`, () => {
    it("run() returns a well-formed CommandResult", async () => {
      const result = await harness.make().run(harness.handle(), ECHO);
      // exitCode is a number or null (never undefined).
      expect(result.exitCode === null || typeof result.exitCode === "number").toBe(true);
      expect(typeof result.stdout).toBe("string");
      expect(typeof result.stderr).toBe("string");
      // `stalled` is the progress-based no-life flag (the wall-clock `timedOut` is gone):
      // optional, so a clean result either omits it or carries a boolean — never a kill flag.
      expect(result.stalled === undefined || typeof result.stalled === "boolean").toBe(true);
    });

    it("run() accepts the handle the seam's allocator hands it", async () => {
      // The handle is opaque at the contract; the substrate must accept it without
      // the caller reading transport fields off it.
      const handle = harness.handle();
      await expect(harness.make().run(handle, ECHO)).resolves.toBeDefined();
    });
  });
}

// Failure-mode spec for impls with an injectable in-band failure path.
export function describeCommandSubstrateFailureConformance(
  label: string,
  harness: CommandSubstrateFailureHarness,
): void {
  describe(`CommandSubstrate failure conformance: ${label}`, () => {
    it("reports a transport failure IN-BAND (result.failure), not as a throw", async () => {
      const { substrate, handle } = harness.makeFailing();
      const result = await substrate.run(handle, ECHO);
      expect(result.failure).toBeDefined();
    });
  });
}

// A minimal SSH handle for impls that need one but don't care about its values.
export function fakeSshHandle(): SshRunnerHandle {
  return {
    backend: "ssh",
    host: "runner",
    port: 22,
    username: "tanren",
    hostKeyFingerprint: "SHA256:conformance",
    identitySecretRef: "runner/conformance/identity",
  };
}
