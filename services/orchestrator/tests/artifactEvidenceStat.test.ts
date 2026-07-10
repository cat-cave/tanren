import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { harvestStepEvidence } from "../src/engine/workflow/gate/harvestStepEvidence.js";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../src/engine/contracts/commandSubstrate.js";

const target: RunnerHandle = {
  backend: "ssh",
  host: "h",
  port: 22,
  username: "u",
  hostKeyFingerprint: "fp",
  identitySecretRef: "i",
};

// ---- REAL-FS ARTIFACT REGRESSION (apex v89 `dist/` false-negative) ---------
//
// The batch merge gate parked spec_a77c39d5 `needs_attention` because tier-3
// (`tsc -p tsconfig.build.json` → the `dist/` output DIRECTORY) reported
// `artifact_absent` despite the build emitting `dist/demo.js` et al. Root cause: the
// artifact probe used a regular-FILE test (`[ -f dist ]`), which is FALSE for a
// directory, so the marker fired → `readReason: "absent"`. These tests run the
// harvester's REAL emitted shell command against a REAL filesystem so a directory
// artifact is genuinely stat'd. Without the fix the directory case fails
// `artifact_absent`; with it, the directory is SEEN.

const execFileAsync = promisify(execFile);

/** A CommandSubstrate that runs the command over a real local `/bin/sh` (no SSH). */
class LocalShellSubstrate implements CommandSubstrate {
  async run(_t: RunnerHandle, c: RunnerCommand): Promise<CommandResult> {
    try {
      const { stdout, stderr } = await execFileAsync("/bin/sh", ["-c", c.command]);
      return { exitCode: 0, stdout, stderr };
    } catch (error) {
      const e = error as { code?: number; stdout?: string; stderr?: string };
      return { exitCode: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
  }
}

describe("harvestStepEvidence artifact — DIRECTORY build output is SEEN (apex v89 `dist/` regression)", () => {
  const tmpDirs: string[] = [];
  const makeWorkspace = async (): Promise<string> => {
    const ws = await mkdtemp(join(tmpdir(), "tanren-artifact-"));
    tmpDirs.push(ws);
    return ws;
  };
  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it("a `dist/` DIRECTORY with built files ⇒ sufficient (the exact v89 false-negative)", async () => {
    const ws = await makeWorkspace();
    // Mirror the scaffold's `tsc` output: a `dist/` directory (NOT a file) of build products.
    await mkdir(join(ws, "dist"), { recursive: true });
    await writeFile(join(ws, "dist", "demo.js"), 'export const demo = () => "hi";\n');
    await writeFile(join(ws, "dist", "demo.d.ts"), "export declare const demo: () => string;\n");

    const harvest = await harvestStepEvidence(
      { ssh: new LocalShellSubstrate(), target, workspacePath: ws },
      { kind: "artifact", path: "dist" },
      "",
    );
    // Pre-fix: `[ -f dist ]` is false ⇒ `artifact_absent`. Post-fix: the directory's
    // content bytes are summed ⇒ present ⇒ sufficient.
    expect(harvest.verdict.sufficient).toBe(true);
    if (!harvest.verdict.sufficient) return;
    expect(harvest.verdict.observed["bytes"]).toBeGreaterThan(0);
  });

  it("an EMPTY `dist/` directory ⇒ artifact_absent readReason empty (a build that emitted nothing)", async () => {
    const ws = await makeWorkspace();
    await mkdir(join(ws, "dist"), { recursive: true });
    const harvest = await harvestStepEvidence(
      { ssh: new LocalShellSubstrate(), target, workspacePath: ws },
      { kind: "artifact", path: "dist" },
      "",
    );
    expect(harvest.verdict.sufficient).toBe(false);
    if (harvest.verdict.sufficient) return;
    expect(harvest.verdict.reason).toBe("artifact_absent");
    expect(harvest.verdict.observed["readReason"]).toBe("empty");
  });

  it("a genuinely ABSENT path ⇒ artifact_absent readReason absent (real negative control)", async () => {
    const ws = await makeWorkspace();
    const harvest = await harvestStepEvidence(
      { ssh: new LocalShellSubstrate(), target, workspacePath: ws },
      { kind: "artifact", path: "dist" },
      "",
    );
    expect(harvest.verdict.sufficient).toBe(false);
    if (harvest.verdict.sufficient) return;
    expect(harvest.verdict.reason).toBe("artifact_absent");
    expect(harvest.verdict.observed["readReason"]).toBe("absent");
  });

  it("a single-FILE artifact still works (`wc -c` byte size ≥ minBytes)", async () => {
    const ws = await makeWorkspace();
    await mkdir(join(ws, "dist"), { recursive: true });
    await writeFile(join(ws, "dist", "app.tar.gz"), "x".repeat(2048));
    const harvest = await harvestStepEvidence(
      { ssh: new LocalShellSubstrate(), target, workspacePath: ws },
      { kind: "artifact", path: "dist/app.tar.gz", minBytes: 1024 },
      "",
    );
    expect(harvest.verdict.sufficient).toBe(true);
  });
});
