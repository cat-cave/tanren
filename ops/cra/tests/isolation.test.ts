import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DisposableCommandRunner } from "../src/isolatedRunner.js";
import { execute, executeChecked, type CommandExecutor } from "../src/process.js";
import { WorktreeManager } from "../src/worktree.js";
import { firstSha, testConfig } from "./helpers.js";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
});

async function git(cwd: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const result = await executeChecked(execute, { command: "git", args: ["-C", cwd, ...args], env, timeoutMs: 30_000 });
  return result.stdout.trim();
}

async function gitFixture() {
  const root = await mkdtemp(resolve(tmpdir(), "cra-git-"));
  roots.push(root);
  const source = resolve(root, "source");
  const remote = resolve(root, "remote.git");
  const supervisor = resolve(root, "supervisor");
  await executeChecked(execute, { command: "git", args: ["init", "--bare", remote] });
  await executeChecked(execute, { command: "git", args: ["init", source] });
  await writeFile(resolve(source, "tracked.txt"), "trusted head\n");
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "CRA test",
    GIT_AUTHOR_EMAIL: "cra@example.invalid",
    GIT_COMMITTER_NAME: "CRA test",
    GIT_COMMITTER_EMAIL: "cra@example.invalid",
  };
  await git(source, ["add", "tracked.txt"], gitEnv);
  await git(source, ["commit", "-m", "fixture"], gitEnv);
  const sha = await git(source, ["rev-parse", "HEAD"]);
  await git(source, ["remote", "add", "origin", remote]);
  await git(source, ["push", "origin", `HEAD:refs/pull/7/head`]);
  await executeChecked(execute, { command: "git", args: ["clone", remote, supervisor] });
  const config = testConfig({
    repositoryRoot: supervisor,
    isolation: { ...testConfig().isolation, worktreeRoot: resolve(root, "worktrees") },
  });
  return { root, supervisor, sha, manager: new WorktreeManager(config) };
}

describe("untrusted worktree isolation", () => {
  it("fetches the immutable pull ref, verifies it, and creates a detached worktree", async () => {
    const fixture = await gitFixture();
    const worktree = await fixture.manager.create(7, fixture.sha);
    expect(await git(worktree.path, ["rev-parse", "HEAD"])).toBe(fixture.sha);
    expect(await git(worktree.path, ["symbolic-ref", "-q", "HEAD"]).catch(() => "detached")).toBe("detached");
    await fixture.manager.cleanup(worktree);
    await expect(readFile(resolve(worktree.path, "tracked.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an adversarial advertised SHA before exposing a worktree", async () => {
    const fixture = await gitFixture();
    await expect(fixture.manager.create(7, firstSha)).rejects.toThrow("fetched head mismatch");
    await expect(
      readFile(resolve(fixture.root, `worktrees/pr-7-${firstSha.slice(0, 12)}/tracked.txt`), "utf8"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("assembles a fail-closed disposable runtime with no host/state mounts", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "cra-runner-contract-"));
    roots.push(root);
    const isolationRoot = resolve(root, "worktrees");
    const worktreePath = resolve(isolationRoot, "pr-7-111111111111");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(worktreePath, { recursive: true });
    await writeFile(resolve(worktreePath, "tracked.txt"), "original\n");
    const executor = vi
      .fn<CommandExecutor>()
      .mockResolvedValueOnce({ stdout: "ok", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });
    const config = testConfig({ isolation: { ...testConfig().isolation, worktreeRoot: isolationRoot } });
    const worktree = { path: worktreePath, ref: "refs/cra/pr-7-111111111111", headSha: firstSha };
    await new DisposableCommandRunner(config, executor).run(worktree, { executable: "pnpm", args: ["test"] });
    const args = executor.mock.calls[0]?.[0].args ?? [];
    expect(args).toEqual(expect.arrayContaining(["--network", "none", "--read-only", "--cap-drop", "ALL"]));
    expect(args).toEqual(expect.arrayContaining(["--security-opt", "no-new-privileges", "--user", "65534:65534"]));
    expect(args.filter((arg) => arg.startsWith("type=bind"))).toEqual([
      expect.stringMatching(/target=\/input,readonly$/u),
    ]);
    expect(args.join(" ")).not.toContain("supervisor.lock");
    expect(executor.mock.calls[1]?.[0].args.slice(0, 2)).toEqual(["rm", "--force"]);
    await expect(
      new DisposableCommandRunner(config, executor).run(
        { ...worktree, path: resolve(root, "state") },
        { executable: "pnpm", args: ["test"] },
      ),
    ).rejects.toThrow("must be a child");
  });

  it("runs PR code in a writable copy while the host worktree and state remain unreachable", async () => {
    const image = testConfig().isolation.image;
    const available = await execute({ command: "docker", args: ["image", "inspect", image], timeoutMs: 10_000 });
    if (available.exitCode !== 0) return;
    const root = await mkdtemp(resolve(tmpdir(), "cra-runner-live-"));
    roots.push(root);
    const worktree = resolve(root, "worktree");
    const state = resolve(root, "state/secret.json");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(worktree);
    await mkdir(resolve(root, "state"));
    await writeFile(resolve(worktree, "tracked.txt"), "host-original\n");
    await writeFile(state, "host-secret\n");
    const config = testConfig({ isolation: { ...testConfig().isolation, worktreeRoot: root } });
    const result = await new DisposableCommandRunner(config).run(
      { path: worktree, ref: "refs/cra/pr-7-111111111111", headSha: firstSha },
      {
        executable: "sh",
        args: [
          "-ceu",
          'printf "sandbox-change\\n" > tracked.txt; test ! -e "$1"; test ! -S /var/run/docker.sock; cat tracked.txt',
          "test-command",
          state,
        ],
      },
    );
    expect(result).toMatchObject({ exitCode: 0, stdout: "sandbox-change\n" });
    expect(await readFile(resolve(worktree, "tracked.txt"), "utf8")).toBe("host-original\n");
    expect(await readFile(state, "utf8")).toBe("host-secret\n");
  });
});
