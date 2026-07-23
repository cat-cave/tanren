import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { CraConfig } from "./config.js";
import { ensurePrivateDirectory } from "./filesystem.js";
import { assertPathContained } from "./paths.js";
import { execute, executeChecked, type CommandExecutor } from "./process.js";

const shaPattern = /^[0-9a-f]{40}$/u;
const filterConfigPattern = /^filter\.(.+)\.(?:clean|smudge|process|required)$/u;
const staticUntrustedGitConfig = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "filter.lfs.clean=",
  "-c",
  "filter.lfs.process=",
  "-c",
  "filter.lfs.smudge=cat",
  "-c",
  "filter.lfs.required=false",
] as const;

export interface VerifiedWorktree {
  readonly path: string;
  readonly ref: string;
  readonly headSha: string;
}

function validateSha(sha: string): void {
  if (!shaPattern.test(sha)) throw new Error(`invalid advertised GitHub head SHA: ${sha}`);
}

export class WorktreeManager {
  public constructor(
    private readonly config: CraConfig,
    private readonly executor: CommandExecutor = execute,
  ) {}

  public async create(pr: number, advertisedHeadSha: string): Promise<VerifiedWorktree> {
    if (!Number.isSafeInteger(pr) || pr <= 0) throw new Error(`invalid PR number: ${pr}`);
    validateSha(advertisedHeadSha);
    const shortSha = advertisedHeadSha.slice(0, 12);
    const ref = `refs/cra/pr-${pr}-${shortSha}`;
    const path = resolve(this.config.isolation.worktreeRoot, `pr-${pr}-${shortSha}`);
    await ensurePrivateDirectory(this.config.isolation.worktreeRoot);
    await rm(path, { recursive: true, force: true });
    try {
      await this.git(["fetch", "--no-tags", "origin", `+refs/pull/${pr}/head:${ref}`]);
      const fetched = (await this.git(["rev-parse", "--verify", `${ref}^{commit}`])).stdout.trim();
      if (fetched !== advertisedHeadSha) {
        throw new Error(`fetched head mismatch for PR #${pr}: advertised ${advertisedHeadSha}, fetched ${fetched}`);
      }
      await this.git(["worktree", "add", "--detach", path, ref]);
      const checkedOut = (await this.git(["-C", path, "rev-parse", "HEAD"])).stdout.trim();
      if (checkedOut !== advertisedHeadSha) {
        throw new Error(
          `worktree head mismatch for PR #${pr}: advertised ${advertisedHeadSha}, checked out ${checkedOut}`,
        );
      }
      return { path, ref, headSha: advertisedHeadSha };
    } catch (error) {
      await this.cleanup({ path, ref, headSha: advertisedHeadSha }).catch(() => {});
      throw error;
    }
  }

  public async cleanup(worktree: VerifiedWorktree): Promise<void> {
    assertPathContained(worktree.path, this.config.isolation.worktreeRoot, "throwaway worktree");
    if (!/^refs\/cra\/pr-\d+-[0-9a-f]{12}$/u.test(worktree.ref))
      throw new Error(`invalid CRA detached ref: ${worktree.ref}`);
    const failures: Error[] = [];
    const removeResult = await this.gitResult(["worktree", "remove", "--force", worktree.path], 60_000);
    if (removeResult.exitCode !== 0 && !/not a working tree|is not a working tree/iu.test(removeResult.stderr)) {
      failures.push(new Error(`failed to remove worktree: ${removeResult.stderr.trim()}`));
    }
    await rm(worktree.path, { recursive: true, force: true });
    const refResult = await this.gitResult(["update-ref", "-d", worktree.ref], 30_000);
    if (refResult.exitCode !== 0) failures.push(new Error(`failed to delete detached ref: ${refResult.stderr.trim()}`));
    if (failures.length > 0) throw new AggregateError(failures, "throwaway worktree cleanup failed");
  }

  private async git(args: readonly string[]) {
    return await executeChecked(this.executor, await this.gitRequest(args, 120_000));
  }

  private async gitResult(args: readonly string[], timeoutMs: number) {
    return await this.executor(await this.gitRequest(args, timeoutMs));
  }

  private async gitRequest(args: readonly string[], timeoutMs: number) {
    return {
      command: this.config.commands.git,
      args: ["-C", this.config.repositoryRoot, ...(await this.untrustedGitConfig()), ...args],
      env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" },
      timeoutMs,
    };
  }

  private async untrustedGitConfig(): Promise<readonly string[]> {
    const configuredFilters = await this.executor({
      command: this.config.commands.git,
      args: [
        "-C",
        this.config.repositoryRoot,
        ...staticUntrustedGitConfig,
        "config",
        "--null",
        "--name-only",
        "--get-regexp",
        "^filter\\..*\\.(clean|smudge|process|required)$",
      ],
      env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" },
      timeoutMs: 30_000,
    });
    if (configuredFilters.exitCode !== 0 && configuredFilters.exitCode !== 1) {
      throw new Error(`failed to enumerate configured Git filters: ${configuredFilters.stderr.trim()}`);
    }
    const filters = new Set(["lfs"]);
    for (const key of configuredFilters.stdout.split("\0")) {
      const match = filterConfigPattern.exec(key);
      if (match?.[1] !== undefined) filters.add(match[1]);
    }
    const overrides: string[] = [...staticUntrustedGitConfig];
    for (const filter of filters) {
      if (filter === "lfs") continue;
      overrides.push(
        "-c",
        `filter.${filter}.clean=`,
        "-c",
        `filter.${filter}.process=`,
        "-c",
        `filter.${filter}.smudge=cat`,
        "-c",
        `filter.${filter}.required=false`,
      );
    }
    return overrides;
  }
}
