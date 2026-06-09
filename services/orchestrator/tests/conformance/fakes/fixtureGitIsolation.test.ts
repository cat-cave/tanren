// REGRESSION GUARD for a live branch-corruption incident: a real-git test fixture
// authored a `Fixture <fixture@local>` commit `base` that STRIPPED THE ENTIRE host repo
// onto the checked-out branch and then checked out `conflict-base` — because git's
// repo-selecting env vars (GIT_DIR / GIT_WORK_TREE) OVERRIDE a `cwd`-scoped git invocation, so a
// leaked one redirected the fixture's `git commit` onto the host worktree's real `.git`.
//
// These tests SIMULATE that exact leak: they set GIT_DIR to a VICTIM repo's `.git`
// (standing in for the host worktree) — WITHOUT GIT_WORK_TREE, the corrupting shape — so
// git uses the victim's `.git` while the work tree defaults to the fixture's cwd. Verified:
// with the env NOT scrubbed and the guard removed, the fixture's `commit base` advances the
// victim's HEAD and `checkout -b conflict-base` switches its branch (the precise live
// corruption). The tests run makeGitFixture / makeJjApplierFixture under that leak and
// assert the victim's HEAD/branch/tree are UNTOUCHED — proving the fixtures confine their
// git ops to their own temp dir (via fixtureGitEnv's scrub + the assertGitDirUnder guard)
// and can NEVER author onto the worktree's branch.
//
// TEST FIXTURE ONLY (under tests/, never src/).

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeGitFixture } from "./gitWorkspaceFixtureRepo.js";
import { makeJjApplierFixture } from "./jjConflictApplierFixtureRepo.js";
import { assertGitDirUnder, fixtureGitEnv } from "./fixtureGitEnv.js";

// A standalone victim git repo with a known HEAD + tree, standing in for the host worktree
// a leaked GIT_DIR/GIT_WORK_TREE would point at. Returns its dir + a snapshot reader.
function makeVictimRepo(): {
  dir: string;
  gitDir: string;
  snapshot: () => { head: string; branch: string; files: string[] };
} {
  const dir = mkdtempSync(join(tmpdir(), "tanren-victim-"));
  const env = fixtureGitEnv(process.env);
  const run = (args: string[]): string => execFileSync("git", args, { cwd: dir, env, encoding: "utf8" }).trim();
  run(["init", "--quiet", "--initial-branch=main"]);
  writeFileSync(join(dir, "PRECIOUS.txt"), "do not delete me\n");
  writeFileSync(join(dir, ".dockerignore"), "node_modules\n");
  run(["add", "-A"]);
  run(["commit", "--quiet", "-m", "victim baseline"]);
  return {
    dir,
    gitDir: join(dir, ".git"),
    snapshot: () => ({
      head: run(["rev-parse", "HEAD"]),
      branch: run(["rev-parse", "--abbrev-ref", "HEAD"]),
      files: readdirSync(dir).sort(),
    }),
  };
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

describe("fixture git isolation (leaked GIT_DIR/GIT_WORK_TREE cannot corrupt the host)", () => {
  it("makeGitFixture does NOT touch a leaked-GIT_DIR victim repo's branch/HEAD/tree", () => {
    const victim = makeVictimRepo();
    tempDirs.push(victim.dir);
    const before = victim.snapshot();

    // Simulate the live leak: the test process has GIT_DIR (only — the corrupting shape)
    // pointing at the victim's `.git`, as a stray hook/CI/parent-git export would. With the
    // env not scrubbed this is EXACTLY what redirected the fixture's `commit base` onto the
    // worktree. The fixture must confine to its temp dir regardless — either by scrubbing
    // the var, or (if the guard fired) by throwing BEFORE any commit. Both leave the victim
    // pristine. (GIT_WORK_TREE is left UNSET so the work tree defaults to the fixture cwd —
    // setting it too is a no-op leak; GIT_DIR-only is the one that actually corrupts.)
    const restoreLeak = leakGitDir(victim.gitDir);
    try {
      const fixture = makeGitFixture();
      tempDirs.push(fixture.scratchRoot);
    } finally {
      restoreLeak();
    }

    expect(victim.snapshot()).toEqual(before);
  });

  it("makeJjApplierFixture does NOT touch a leaked-GIT_DIR victim repo's branch/HEAD/tree", () => {
    const victim = makeVictimRepo();
    tempDirs.push(victim.dir);
    const before = victim.snapshot();

    const restoreLeak = leakGitDir(victim.gitDir);
    try {
      const fixture = makeJjApplierFixture({ conflicting: true });
      // The fixture's bare origin must be real (not the victim's git dir).
      expect(fixture.originPath).not.toBe(victim.gitDir);
    } finally {
      restoreLeak();
    }

    expect(victim.snapshot()).toEqual(before);
  });

  it("assertGitDirUnder THROWS when git resolves outside the temp root (the guard bites)", () => {
    const victim = makeVictimRepo();
    tempDirs.push(victim.dir);
    const elsewhere = mkdtempSync(join(tmpdir(), "tanren-elsewhere-"));
    tempDirs.push(elsewhere);
    const seed = join(elsewhere, "seed");
    mkdirSync(seed, { recursive: true });

    // Force git to resolve to the victim's dir even though cwd is `seed`, and assert the
    // guard catches the escape (resolved git dir is NOT under `elsewhere`).
    const leakedEnv = { ...fixtureGitEnv(process.env), GIT_DIR: victim.gitDir };
    expect(() => assertGitDirUnder(seed, elsewhere, leakedEnv)).toThrow(/isolation BREACH/u);

    // The control: with the scrubbed env + a real init under `elsewhere`, the guard passes.
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: seed,
      env: fixtureGitEnv(process.env),
    });
    expect(() => assertGitDirUnder(seed, elsewhere, fixtureGitEnv(process.env))).not.toThrow();
  });
});

/**
 * Leak GIT_DIR (only — the corrupting shape) into the process env for the duration of a
 * fixture call, returning a restorer. GIT_WORK_TREE is deliberately NOT set: with it set
 * the work tree is the victim's (a no-op leak); GIT_DIR-only makes the work tree default to
 * the fixture's cwd, which is what lands the seed tree onto the victim's branch.
 */
function leakGitDir(gitDir: string): () => void {
  const prevDir = process.env.GIT_DIR;
  const prevWork = process.env.GIT_WORK_TREE;
  process.env.GIT_DIR = gitDir;
  delete process.env.GIT_WORK_TREE;
  return () => {
    restore("GIT_DIR", prevDir);
    restore("GIT_WORK_TREE", prevWork);
  };
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
