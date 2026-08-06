import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../src/engine/contracts/commandSubstrate.js";
import { ensureWorkspaceDepsInstalled } from "../src/engine/workspace/bootstrap.js";
import { miseRunScope } from "../src/engine/ssh/miseActivate.js";

const target: RunnerHandle = { backend: "ssh" };

class RecordingSsh implements CommandSubstrate {
  readonly commands: RunnerCommand[] = [];

  async run(_target: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command);
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

describe("ensureWorkspaceDepsInstalled · retraction status", () => {
  it("does not activate or bootstrap when stale toolchain cleanup fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "tanren-retraction-"));
    try {
      const bin = join(root, "bin");
      const workspace = join(root, "repo");
      const activationLog = join(root, "activation.log");
      const bootstrapLog = join(root, "bootstrap.log");
      mkdirSync(bin);
      mkdirSync(workspace);
      writeFileSync(join(workspace, "justfile"), "");
      writeFileSync(activationLog, "");
      writeFileSync(bootstrapLog, "");

      const scope = miseRunScope(workspace);
      writeFileSync(scope.markerFile.replace("$HOME", root), "stale");
      const fakeRm = join(bin, "rm");
      const fakeMise = join(bin, "mise");
      const fakeJust = join(bin, "just");
      writeFileSync(fakeRm, "#!/bin/sh\nexit 1\n");
      writeFileSync(
        fakeMise,
        `#!/bin/sh\nprintf '%s' activated > ${JSON.stringify(activationLog)}\nprintf '%s\\n' 'export TANREN_TEST_ACTIVE=1'\n`,
      );
      writeFileSync(fakeJust, `#!/bin/sh\nprintf '%s' bootstrapped > ${JSON.stringify(bootstrapLog)}\n`);
      for (const executable of [fakeRm, fakeMise, fakeJust]) chmodSync(executable, 0o755);

      const ssh = new RecordingSsh();
      await ensureWorkspaceDepsInstalled({ ssh, target, workspacePath: workspace, command: "just bootstrap" });
      const executed = ssh.commands[1]?.command;
      if (executed === undefined) throw new Error("expected the guarded bootstrap command");

      const retraction = `rm -f "${scope.markerFile}" "${scope.configFile}"`;
      expect(executed).toContain(`${retraction} && {`);
      expect(executed.indexOf(retraction)).toBeLessThan(executed.indexOf("if [ -f 'mise.toml' ]"));
      expect(executed).toContain("{ just bootstrap; }");

      expect(() =>
        execFileSync("sh", ["-c", executed], {
          cwd: workspace,
          env: { ...process.env, HOME: root, PATH: `${bin}:${process.env.PATH ?? ""}` },
        }),
      ).toThrow(/Command failed/u);
      expect(readFileSync(activationLog, "utf8")).toBe("");
      expect(readFileSync(bootstrapLog, "utf8")).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
