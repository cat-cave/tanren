// Run-sandbox REAPER (layer 2 of the ≈204 GB disk-leak fix) unit coverage. Drives
// `RunWorkspaceReaper.tick()` against an injected FAKE CommandSubstrate (it serves a
// synthetic `/workspace/runs` `find` listing + records every `rm -rf`) and a fake
// active-run source. Proves the safety invariants: a stale + inactive dir is removed;
// an ACTIVE run's dir is KEPT even when old; a too-young dir is KEPT; a malformed
// (non-`run_*`) entry is SKIPPED (never deleted); an `rm` failure on one dir does not
// stop the others; and a second tick is idempotent. The fakes are TEST FIXTURES.

import { describe, expect, it } from "vitest";
import { RunWorkspaceReaper, parseRunDirListing } from "../src/engine/worker/runWorkspaceReaper.js";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../src/engine/contracts/commandSubstrate.js";

const TARGET: RunnerHandle = { backend: "ssh" };
const NOW = Date.parse("2026-06-05T00:00:00Z");
// 60-min retention window, 30-min sweep cadence.
const RETENTION_MS = 60 * 60_000;
const INTERVAL_MS = 30 * 60_000;

interface DirSeed {
  /** The basename under /workspace/runs (a run id, or a malformed entry). */
  name: string;
  /** Dir mtime as ms-since-epoch. */
  mtimeMs: number;
}

/**
 * FAKE CommandSubstrate (TEST FIXTURE). Answers the reaper's `find` listing from an
 * in-memory dir set and records every `rm -rf <path>` it is asked to run. A path in
 * `failRm` makes that one `rm` report a non-zero exit (the per-dir tolerance case).
 */
class FakeReaperSubstrate implements CommandSubstrate {
  rmPaths: string[] = [];
  constructor(
    private dirs: DirSeed[],
    private readonly failRm: Set<string> = new Set(),
  ) {}

  /** The dirs still present (a successful `rm` removes the entry from the listing). */
  remaining(): string[] {
    return this.dirs.map((d) => d.name);
  }

  async run(_handle: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    const cmd = command.command;
    if (cmd.startsWith("find ")) {
      const stdout = this.dirs.map((d) => `${d.name}\t${(d.mtimeMs / 1000).toFixed(7)}`).join("\n") + "\n";
      return { exitCode: 0, stdout, stderr: "", timedOut: false };
    }
    const match = /^rm -rf '(.+)'$/u.exec(cmd);
    if (match !== null) {
      const path = match[1]!;
      this.rmPaths.push(path);
      if (this.failRm.has(path)) {
        return { exitCode: 1, stdout: "", stderr: "rm: permission denied", timedOut: false };
      }
      // A successful rm removes the dir from the in-memory listing (idempotence).
      const base = path.slice("/workspace/runs/".length);
      this.dirs = this.dirs.filter((d) => d.name !== base);
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    }
    throw new Error(`unexpected command: ${cmd}`);
  }
}

function reaper(substrate: CommandSubstrate, active: Set<string>): RunWorkspaceReaper {
  return new RunWorkspaceReaper(
    {
      ssh: substrate,
      resolveTarget: async () => TARGET,
      activeRunIds: async () => active,
      retentionMs: RETENTION_MS,
      now: () => NOW,
    },
    INTERVAL_MS,
  );
}

/** A dir mtime that is `minutes` old relative to NOW. */
function ageMin(minutes: number): number {
  return NOW - minutes * 60_000;
}

describe("RunWorkspaceReaper.tick — safety invariants", () => {
  it("removes a stale + inactive dir", async () => {
    const sub = new FakeReaperSubstrate([{ name: "run_stale", mtimeMs: ageMin(120) }]);
    const removed = await reaper(sub, new Set()).tick();
    expect(removed).toEqual(["run_stale"]);
    expect(sub.rmPaths).toEqual(["/workspace/runs/run_stale"]);
    expect(sub.remaining()).toEqual([]);
  });

  it("KEEPS an active run's dir even when old (active protection is absolute)", async () => {
    const sub = new FakeReaperSubstrate([{ name: "run_live", mtimeMs: ageMin(100_000) }]);
    const removed = await reaper(sub, new Set(["run_live"])).tick();
    expect(removed).toEqual([]);
    expect(sub.rmPaths).toEqual([]);
    expect(sub.remaining()).toEqual(["run_live"]);
  });

  it("KEEPS a too-young dir (within the retention window)", async () => {
    const sub = new FakeReaperSubstrate([{ name: "run_young", mtimeMs: ageMin(30) }]);
    const removed = await reaper(sub, new Set()).tick();
    expect(removed).toEqual([]);
    expect(sub.rmPaths).toEqual([]);
    expect(sub.remaining()).toEqual(["run_young"]);
  });

  it("SKIPS a malformed (non-run_*) entry — never deletes it", async () => {
    const sub = new FakeReaperSubstrate([
      { name: "..", mtimeMs: ageMin(100_000) },
      { name: "lost+found", mtimeMs: ageMin(100_000) },
      { name: "spec_123", mtimeMs: ageMin(100_000) },
    ]);
    const removed = await reaper(sub, new Set()).tick();
    expect(removed).toEqual([]);
    expect(sub.rmPaths).toEqual([]);
    expect(sub.remaining()).toEqual(["..", "lost+found", "spec_123"]);
  });

  it("one rm failure does not stop the rest of the sweep", async () => {
    const sub = new FakeReaperSubstrate(
      [
        { name: "run_a", mtimeMs: ageMin(120) },
        { name: "run_bad", mtimeMs: ageMin(120) },
        { name: "run_c", mtimeMs: ageMin(120) },
      ],
      new Set(["/workspace/runs/run_bad"]),
    );
    const removed = await reaper(sub, new Set()).tick();
    // run_bad's rm exited non-zero → not in `removed`, still present; the others removed.
    expect(removed.sort()).toEqual(["run_a", "run_c"]);
    expect(sub.rmPaths.sort()).toEqual(["/workspace/runs/run_a", "/workspace/runs/run_bad", "/workspace/runs/run_c"]);
    expect(sub.remaining()).toEqual(["run_bad"]);
  });

  it("is idempotent: a second tick removes nothing new", async () => {
    const sub = new FakeReaperSubstrate([
      { name: "run_stale", mtimeMs: ageMin(120) },
      { name: "run_live", mtimeMs: ageMin(120) },
      { name: "run_young", mtimeMs: ageMin(10) },
    ]);
    const r = reaper(sub, new Set(["run_live"]));
    const first = await r.tick();
    expect(first).toEqual(["run_stale"]);
    const second = await r.tick();
    expect(second).toEqual([]);
    // After the first sweep only run_stale was gone; the active + young dirs persist.
    expect(sub.remaining().sort()).toEqual(["run_live", "run_young"]);
  });

  it("skips the sweep when the active-run read fails (no degrade to delete-all)", async () => {
    const sub = new FakeReaperSubstrate([{ name: "run_stale", mtimeMs: ageMin(120) }]);
    const r = new RunWorkspaceReaper(
      {
        ssh: sub,
        resolveTarget: async () => TARGET,
        activeRunIds: async () => {
          throw new Error("db unreachable");
        },
        retentionMs: RETENTION_MS,
        now: () => NOW,
      },
      INTERVAL_MS,
    );
    const removed = await r.tick();
    expect(removed).toEqual([]);
    expect(sub.rmPaths).toEqual([]);
    expect(sub.remaining()).toEqual(["run_stale"]);
  });

  it("returns [] (no boot block) when the runner target cannot be resolved", async () => {
    const sub = new FakeReaperSubstrate([{ name: "run_stale", mtimeMs: ageMin(120) }]);
    const r = new RunWorkspaceReaper(
      {
        ssh: sub,
        resolveTarget: async () => {
          throw new Error("runner unreachable");
        },
        activeRunIds: async () => new Set(),
        retentionMs: RETENTION_MS,
        now: () => NOW,
      },
      INTERVAL_MS,
    );
    const removed = await r.tick();
    expect(removed).toEqual([]);
    expect(sub.rmPaths).toEqual([]);
  });

  it("returns [] and does not throw when the listing fails", async () => {
    const failing: CommandSubstrate = {
      async run() {
        return {
          exitCode: null,
          stdout: "",
          stderr: "",
          timedOut: false,
          failure: { kind: "ssh_failed", target: "runner", message: "connection refused" },
        };
      },
    };
    const removed = await reaper(failing, new Set()).tick();
    expect(removed).toEqual([]);
  });
});

describe("parseRunDirListing", () => {
  it("parses `<basename>\\t<epoch-seconds>` lines into ms entries, dropping malformed lines", () => {
    const TAB = "\t";
    const stdout = [
      `run_a${TAB}1717545600.5000000`,
      `run_b${TAB}1717549200`,
      "garbage-no-tab",
      `run_c${TAB}not-a-number`,
      "",
    ].join("\n");
    const entries = parseRunDirListing(stdout);
    expect(entries).toEqual([
      { runId: "run_a", mtimeMs: 1717545600500 },
      { runId: "run_b", mtimeMs: 1717549200000 },
    ]);
  });
});
