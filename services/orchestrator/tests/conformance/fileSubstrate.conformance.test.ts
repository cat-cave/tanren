// Per-implementation invocations of the FileSubstrate conformance suite. The
// in-memory FakeFileSubstrate and the real CommandFileSubstrate (file transfer
// OVER a CommandSubstrate) run through the SAME behavior spec. The failing case
// drives CommandFileSubstrate over a CommandSubstrate that reports an in-band
// transport failure, proving the file seam propagates it as ok=false (never a
// throw). A native file-API backend gets coverage by adding one harness block.
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../../src/engine/contracts/commandSubstrate.js";
import { FakeFileSubstrate } from "../../src/engine/contracts/fileSubstrate.js";
import type { RunnerHandle } from "../../src/engine/contracts/allocator.js";
import { defineFailure } from "../../src/engine/failure.js";
import { CommandFileSubstrate } from "../../src/engine/ssh/commandFileSubstrate.js";
import {
  describeFileSubstrateConformance,
  describeFileSubstrateFailureConformance,
} from "./fileSubstrateConformance.js";

// A CommandSubstrate that returns a fixed result for every run — used to drive
// CommandFileSubstrate's success and in-band-failure paths.
class ScriptedCommandSubstrate implements CommandSubstrate {
  constructor(private readonly result: CommandResult) {}
  async run(_handle: RunnerHandle, _command: RunnerCommand): Promise<CommandResult> {
    return this.result;
  }
}

const OK: CommandResult = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
const FAILED: CommandResult = {
  exitCode: null,
  stdout: "",
  stderr: "",
  timedOut: true,
  failure: defineFailure({ kind: "ssh_failed", target: "runner", message: "dial timed out" }),
};

describeFileSubstrateConformance("FakeFileSubstrate", {
  make: () => new FakeFileSubstrate(),
});

describeFileSubstrateConformance("CommandFileSubstrate (over CommandSubstrate)", {
  make: () => new CommandFileSubstrate(new ScriptedCommandSubstrate(OK)),
});

describeFileSubstrateFailureConformance("CommandFileSubstrate (over CommandSubstrate)", {
  makeFailing: () => new CommandFileSubstrate(new ScriptedCommandSubstrate(FAILED)),
});
