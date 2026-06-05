// Seam conformance suite for the FileSubstrate contract
// (engine/contracts/fileSubstrate.ts). A reusable behavior spec invoked once per
// implementation via `describeFileSubstrateConformance`. It asserts the CONTRACT
// only — that writeFile/put report a FileTransferResult and a transport failure
// surfaces IN-BAND (result.ok === false, result.failure set) rather than as a
// throw. The command-over-heredoc impl and any native file-API backend pass the
// same spec.
import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../../src/engine/contracts/allocator.js";
import type { FileSubstrate } from "../../src/engine/contracts/fileSubstrate.js";
import { fakeSshHandle } from "./commandSubstrateConformance.js";

export interface FileSubstrateConformanceHarness {
  make(): FileSubstrate;
  handle?(): RunnerHandle;
}

// Failure-mode harness for impls whose writes can be forced to fail. Passed to
// the separate `describeFileSubstrateFailureConformance` so the success spec
// stays unconditional (no `if` around `it`).
export interface FileSubstrateFailureHarness {
  makeFailing(): FileSubstrate;
  handle?(): RunnerHandle;
}

export function describeFileSubstrateConformance(label: string, harness: FileSubstrateConformanceHarness): void {
  const handle = (): RunnerHandle => (harness.handle ?? fakeSshHandle)();

  describe(`FileSubstrate conformance: ${label}`, () => {
    it("writeFile() returns a FileTransferResult", async () => {
      const result = await harness.make().writeFile(handle(), {
        path: "/home/tanren/.tanren/runs/conf/secret.json",
        content: '{"k":"v"}',
        mode: 0o600,
        timeoutMs: 1_000,
      });
      expect(typeof result.ok).toBe("boolean");
    });

    it("put() is the byte-stream alias of writeFile()", async () => {
      const result = await harness.make().put(handle(), {
        path: "/home/tanren/.tanren/runs/conf/blob",
        content: "bytes",
        timeoutMs: 1_000,
      });
      expect(typeof result.ok).toBe("boolean");
    });
  });
}

// Failure-mode spec for impls with an injectable in-band failure path.
export function describeFileSubstrateFailureConformance(label: string, harness: FileSubstrateFailureHarness): void {
  const handle = (): RunnerHandle => (harness.handle ?? fakeSshHandle)();

  describe(`FileSubstrate failure conformance: ${label}`, () => {
    it("reports a transport failure IN-BAND (ok=false, failure set), not as a throw", async () => {
      const result = await harness.makeFailing().writeFile(handle(), {
        path: "/home/tanren/.tanren/runs/conf/secret.json",
        content: "x",
        mode: 0o600,
        timeoutMs: 1_000,
      });
      expect(result.ok).toBe(false);
      expect(result.failure).toBeDefined();
    });
  });
}
