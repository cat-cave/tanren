// Tests for the HOST-SIDE entity-risk producer (§3.1): it shells `sem diff
// --format json` READ-ONLY on the runner over the command substrate and normalizes
// the output into the neutral `EntityChangeMap`, with the GRACEFUL `unknown`
// fallback (and the OBSERVABLE unexpected-failure distinction) the doctrine demands.
//
// The fixtures here are REAL `sem diff --format json` shapes (captured from sem
// 0.9.0, the version vendored in runner/Dockerfile) — a structural diff, a
// cosmetic-only diff, an empty diff, and the line-chunk fallback sem emits when it
// cannot structurally parse a stack. The parser is exercised directly (pure, no IO)
// and through the producer over a scripted fake substrate (no real git/sem).
import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../src/engine/contracts/commandSubstrate.js";
import { parseSemDiffJson, produceEntityChangeMap, semDiffCommand } from "../src/engine/oracle/semEntityProducer.js";

const target: RunnerHandle = { backend: "ssh" };

// A scripted CommandSubstrate: returns ONE canned `CommandResult` and captures the
// command it was asked to run (so a test can assert the exact `sem diff` shell).
class ScriptedSubstrate implements CommandSubstrate {
  lastCommand: RunnerCommand | undefined;
  constructor(private readonly result: CommandResult) {}
  async run(_handle: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.lastCommand = command;
    return this.result;
  }
}

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "", timedOut: false };
}

// ── REAL `sem diff --format json` fixtures (sem 0.9.0) ────────────────────────

// A structural diff: `alpha` modified (signature change), `helper` modified,
// `beta` added — all `structuralChange: true`/null, real entity types.
const SEM_STRUCTURAL = JSON.stringify({
  summary: { fileCount: 1, added: 1, modified: 2, deleted: 0, moved: 0, renamed: 0, reordered: 0, binary: 0, total: 3 },
  changes: [
    {
      entityId: "a.ts::function::alpha",
      changeType: "modified",
      entityType: "function",
      entityName: "alpha",
      structuralChange: true,
    },
    {
      entityId: "a.ts::function::helper",
      changeType: "modified",
      entityType: "function",
      entityName: "helper",
      structuralChange: true,
    },
    {
      entityId: "a.ts::function::beta",
      changeType: "added",
      entityType: "function",
      entityName: "beta",
      structuralChange: null,
    },
  ],
  binaryChanges: [],
});

// A cosmetic-only diff: `alpha` reformatted (`structuralChange: false`).
const SEM_COSMETIC = JSON.stringify({
  summary: { fileCount: 1, added: 0, modified: 1, deleted: 0, moved: 0, renamed: 0, reordered: 0, binary: 0, total: 1 },
  changes: [
    {
      entityId: "a.ts::function::alpha",
      changeType: "modified",
      entityType: "function",
      entityName: "alpha",
      structuralChange: false,
    },
  ],
  binaryChanges: [],
});

// A rename: `alpha` → `alphaRenamed`, sem keeps the structural-hash identity.
const SEM_RENAME = JSON.stringify({
  summary: { fileCount: 1, added: 0, modified: 0, deleted: 0, moved: 0, renamed: 1, reordered: 0, binary: 0, total: 1 },
  changes: [
    {
      entityId: "a.ts::function::alphaRenamed",
      changeType: "renamed",
      entityType: "function",
      entityName: "alphaRenamed",
      oldEntityName: "alpha",
      structuralChange: false,
    },
  ],
  binaryChanges: [],
});

// An empty diff (no entities changed) — the classifier's cosmetic-skip case.
const SEM_EMPTY = JSON.stringify({
  summary: { fileCount: 0, added: 0, modified: 0, deleted: 0, moved: 0, renamed: 0, reordered: 0, binary: 0, total: 0 },
  changes: [],
  binaryChanges: [],
});

// The line-chunk fallback sem emits when it CANNOT structurally parse a stack:
// every change is `entityType: "chunk"` with `entityName: "lines N-N"`.
const SEM_CHUNK_FALLBACK = JSON.stringify({
  summary: { fileCount: 1, added: 0, modified: 1, deleted: 0, moved: 0, renamed: 0, reordered: 0, binary: 0, total: 1 },
  changes: [
    {
      entityId: "f.dat::chunk::lines 1-1",
      changeType: "modified",
      entityType: "chunk",
      entityName: "lines 1-1",
      structuralChange: null,
    },
  ],
  binaryChanges: [],
});

describe("parseSemDiffJson — real sem diff JSON → neutral EntityChangeMap", () => {
  it("parses a structural diff into the neutral entity-change map (kinds + natures)", () => {
    const out = parseSemDiffJson(SEM_STRUCTURAL);
    if (!("map" in out)) throw new Error(`expected a map, got unavailable: ${JSON.stringify(out)}`);
    expect(out.map.entities).toHaveLength(3);
    expect(out.map.entities).toEqual([
      { kind: "modified", nature: "structural", visibility: "unknown", id: "a.ts::function::alpha" },
      { kind: "modified", nature: "structural", visibility: "unknown", id: "a.ts::function::helper" },
      // `structuralChange: null` → nature "unknown" (conservative, not cosmetic).
      { kind: "added", nature: "unknown", visibility: "unknown", id: "a.ts::function::beta" },
    ]);
  });

  it("maps structuralChange:false to a cosmetic nature", () => {
    const out = parseSemDiffJson(SEM_COSMETIC);
    if (!("map" in out)) throw new Error("expected a map");
    expect(out.map.entities).toEqual([
      { kind: "modified", nature: "cosmetic", visibility: "unknown", id: "a.ts::function::alpha" },
    ]);
  });

  it("maps a rename to the renamed kind, carrying entity identity", () => {
    const out = parseSemDiffJson(SEM_RENAME);
    if (!("map" in out)) throw new Error("expected a map");
    expect(out.map.entities[0]).toMatchObject({ kind: "renamed", id: "a.ts::function::alphaRenamed" });
  });

  it("parses an EMPTY diff into a valid empty map (the cosmetic-skip case, NOT an unavailability)", () => {
    const out = parseSemDiffJson(SEM_EMPTY);
    if (!("map" in out)) throw new Error("expected a map");
    expect(out.map.entities).toHaveLength(0);
  });

  it("returns producer-unsupported when EVERY change is a line-chunk fallback (sem can't parse the stack)", () => {
    const out = parseSemDiffJson(SEM_CHUNK_FALLBACK);
    expect(out).toEqual({ unavailable: "producer-unsupported" });
  });

  it("returns producer-errored on non-JSON output (sem ran but emitted a non-contract banner)", () => {
    expect(parseSemDiffJson("Error: git error: revspec 'deadbeef' not found")).toEqual({
      unavailable: "producer-errored",
    });
  });

  it("returns producer-errored when the JSON lacks the changes array (wrong shape)", () => {
    expect(parseSemDiffJson(JSON.stringify({ summary: {} }))).toEqual({ unavailable: "producer-errored" });
  });
});

describe("produceEntityChangeMap — shells sem over the command substrate (read-only)", () => {
  it("shells the exact `sem diff --from <baselineSha> --to HEAD --format json` in the workspace", async () => {
    const sub = new ScriptedSubstrate(ok(SEM_STRUCTURAL));
    await produceEntityChangeMap({
      ssh: sub,
      target,
      workspacePath: "/ws/repo",
      baselineSha: "abc123",
      timeoutMs: 5_000,
    });
    expect(sub.lastCommand?.command).toBe(semDiffCommand("abc123"));
    expect(sub.lastCommand?.command).toBe("sem diff --from abc123 --to HEAD --format json");
    expect(sub.lastCommand?.cwd).toBe("/ws/repo");
  });

  it("returns the classified map on a clean exit-0 structural diff", async () => {
    const sub = new ScriptedSubstrate(ok(SEM_STRUCTURAL));
    const out = await produceEntityChangeMap({
      ssh: sub,
      target,
      workspacePath: "/ws",
      baselineSha: "b",
      timeoutMs: 1_000,
    });
    if (!("map" in out)) throw new Error("expected a map");
    expect(out.map.entities).toHaveLength(3);
  });

  it("gracefully returns no-producer when sem is ABSENT (exit 127)", async () => {
    const sub = new ScriptedSubstrate({ exitCode: 127, stdout: "", stderr: "sem: command not found", timedOut: false });
    const out = await produceEntityChangeMap({
      ssh: sub,
      target,
      workspacePath: "/ws",
      baselineSha: "b",
      timeoutMs: 1_000,
    });
    expect(out).toEqual({ unavailable: "no-producer" });
  });

  it("gracefully returns no-producer when the shell reports 'command not found' (non-127 exit)", async () => {
    const sub = new ScriptedSubstrate({
      exitCode: 1,
      stdout: "",
      stderr: "bash: sem: command not found",
      timedOut: false,
    });
    const out = await produceEntityChangeMap({
      ssh: sub,
      target,
      workspacePath: "/ws",
      baselineSha: "b",
      timeoutMs: 1_000,
    });
    expect(out).toEqual({ unavailable: "no-producer" });
  });

  it("returns producer-errored (OBSERVABLE/loud) when sem is PRESENT but errors (non-zero, real failure)", async () => {
    const sub = new ScriptedSubstrate({
      exitCode: 1,
      stdout: "",
      stderr: "Error: git error: revspec 'deadbeef' not found",
      timedOut: false,
    });
    const out = await produceEntityChangeMap({
      ssh: sub,
      target,
      workspacePath: "/ws",
      baselineSha: "deadbeef",
      timeoutMs: 1_000,
    });
    expect(out).toEqual({ unavailable: "producer-errored" });
  });

  it("returns producer-errored on a substrate transport failure (the runner is otherwise live)", async () => {
    const sub = new ScriptedSubstrate({
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      failure: { kind: "ssh_failed", target: "runner", message: "connection reset" },
    });
    const out = await produceEntityChangeMap({
      ssh: sub,
      target,
      workspacePath: "/ws",
      baselineSha: "b",
      timeoutMs: 1_000,
    });
    expect(out).toEqual({ unavailable: "producer-errored" });
  });

  it("returns producer-errored on a command timeout", async () => {
    const sub = new ScriptedSubstrate({ exitCode: null, stdout: "", stderr: "", timedOut: true });
    const out = await produceEntityChangeMap({
      ssh: sub,
      target,
      workspacePath: "/ws",
      baselineSha: "b",
      timeoutMs: 1_000,
    });
    expect(out).toEqual({ unavailable: "producer-errored" });
  });

  it("returns producer-unsupported when sem exits 0 but only line-chunks (unparseable stack)", async () => {
    const sub = new ScriptedSubstrate(ok(SEM_CHUNK_FALLBACK));
    const out = await produceEntityChangeMap({
      ssh: sub,
      target,
      workspacePath: "/ws",
      baselineSha: "b",
      timeoutMs: 1_000,
    });
    expect(out).toEqual({ unavailable: "producer-unsupported" });
  });
});
