import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { CraConfig } from "./config.js";
import { assertPathContained } from "./paths.js";
import { execute, type CommandExecutor, type CommandResult } from "./process.js";
import type { VerifiedWorktree } from "./worktree.js";

export interface IsolatedCommand {
  readonly executable: string;
  readonly args: readonly string[];
}

function safeMountPath(path: string): void {
  if (path.includes(",") || path.includes("\n") || path.includes("\0")) {
    throw new Error(`worktree path cannot be represented safely as a container mount: ${path}`);
  }
}

export class DisposableCommandRunner {
  public constructor(
    private readonly config: CraConfig,
    private readonly executor: CommandExecutor = execute,
  ) {}

  public async run(worktree: VerifiedWorktree, command: IsolatedCommand): Promise<CommandResult> {
    if (command.executable.length === 0 || command.executable.includes("\0"))
      throw new Error("invalid isolated executable");
    assertPathContained(worktree.path, this.config.isolation.worktreeRoot, "isolated worktree");
    const source = await realpath(worktree.path);
    assertPathContained(source, this.config.isolation.worktreeRoot, "resolved isolated worktree");
    safeMountPath(source);
    const name = `tanren-cra-${randomUUID()}`;
    const runtime = this.config.commands.containerRuntime;
    const args = [
      "run",
      "--rm",
      "--name",
      name,
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      String(this.config.isolation.pidsLimit),
      "--memory",
      this.config.isolation.memory,
      "--cpus",
      String(this.config.isolation.cpus),
      "--user",
      "65534:65534",
      "--env",
      "HOME=/tmp/home",
      "--env",
      "CI=true",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777",
      "--tmpfs",
      "/work:rw,exec,nosuid,nodev,size=4g,mode=1777",
      "--mount",
      `type=bind,source=${source},target=/input,readonly`,
      "--workdir",
      "/work",
      "--entrypoint",
      "sh",
      this.config.isolation.image,
      "-ceu",
      'cp -R /input/. /work/; exec "$@"',
      "cra-command",
      command.executable,
      ...command.args,
    ];
    try {
      return await this.executor({
        command: runtime,
        args,
        env: process.env,
        timeoutMs: this.config.isolation.timeoutMs,
      });
    } finally {
      await this.executor({
        command: runtime,
        args: ["rm", "--force", name],
        env: process.env,
        timeoutMs: 30_000,
      }).catch(() => {});
    }
  }
}
