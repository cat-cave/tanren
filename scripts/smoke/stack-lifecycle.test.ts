import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStackContext, resolveHostPorts } from "./stack-context.js";
import { STAGE_REGISTRY, SMOKE_STAGES } from "./stack-gates.js";
import {
  allocateRuntimeRoot,
  decodeTerminalCliStatus,
  ExecutedBindings,
  LifecycleLedger,
  readCandidateIdentity,
  safeError,
  sanitizeComposeLogs,
} from "./stack-lifecycle.js";
import { abortableDelay, processGroupAbsent, runCommand } from "./stack-runtime.js";

const roots: string[] = [];

async function repository(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `tanren-${name}-`));
  roots.push(root);
  execFileSync("git", ["init", "-q", root]);
  await writeFile(join(root, "tracked.txt"), `${name}\n`);
  execFileSync("git", ["-C", root, "add", "tracked.txt"]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.name=Smoke",
    "-c",
    "user.email=smoke@example.invalid",
    "commit",
    "-qm",
    name,
  ]);
  return root;
}

afterEach(() => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("smoke lifecycle isolation", () => {
  it("uses the invoking worktree despite poisoned clean decoy Git selectors", async () => {
    const invoking = await repository("invoking");
    const decoy = await repository("decoy");
    const identity = await readCandidateIdentity(invoking, {
      ...process.env,
      GIT_DIR: join(decoy, ".git"),
      GIT_WORK_TREE: decoy,
      GIT_INDEX_FILE: join(decoy, ".git", "index"),
    });
    expect(identity.root).toBe(invoking);
    expect(identity.head).toBe(execFileSync("git", ["-C", invoking, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
    expect(identity.head).not.toBe(
      execFileSync("git", ["-C", decoy, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    );
    expect(Object.keys(identity.env).some((name) => name.startsWith("GIT_"))).toBe(false);
  });

  it("allocates runtime roots exclusively and rejects stale reuse", async () => {
    const base = await mkdtemp(join(tmpdir(), "tanren-exclusive-"));
    roots.push(base);
    const runtime = join(base, "parent", "run");
    const results = await Promise.allSettled([allocateRuntimeRoot(runtime), allocateRuntimeRoot(runtime)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(allocateRuntimeRoot(runtime)).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("derives the production stage list only from the ordered descriptor registry", async () => {
    expect(SMOKE_STAGES).toEqual(STAGE_REGISTRY.map((stage) => stage.name));
    expect(STAGE_REGISTRY.some((stage) => stage.name === "seed-platform-credentials" && stage.optional)).toBe(true);
    expect(STAGE_REGISTRY.filter((stage) => stage.kind === "finalize").map((stage) => stage.name)).toEqual([
      "capture-compose-logs",
      "teardown-stack",
      "attest-resource-leaks",
      "remove-build-context",
      "remove-runtime-dir",
      "publish-receipt",
    ]);
    const invalid = new LifecycleLedger("not-a-production-stage");
    await expect(invalid.run("preflight-git-identity", () => {})).rejects.toThrow(/unknown smoke failure stage/u);
    for (const stage of SMOKE_STAGES) {
      const ledger = new LifecycleLedger(stage);
      await expect(ledger.run(stage, () => "unreachable")).rejects.toThrow(`injected smoke failure at ${stage}`);
      expect(ledger.stages).toEqual([expect.objectContaining({ name: stage, status: "failed" })]);
      expect(() => ledger.assertFailureInjectionObserved()).not.toThrow();
    }
  });

  it("fences a terminal commit so receipt and exit cannot contradict", () => {
    const ledger = new LifecycleLedger();
    ledger.beginTerminalPrepare();
    ledger.commitTerminal('{"status":"failed"}\n', 1);
    expect(ledger.terminalState()).toEqual({
      phase: "committed",
      receipt: '{"status":"failed"}\n',
      exitCode: 1,
    });
    ledger.commitTerminal('{"status":"failed"}\n', 1);
    expect(() => ledger.commitTerminal('{"status":"passed"}\n', 0)).toThrow(/contradiction/u);
  });

  it("aborts a live child without a process group leak and proves ESRCH", async () => {
    const ledger = new LifecycleLedger();
    let pgid: number | undefined;
    const child = runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: process.cwd(),
      env: process.env,
      capture: true,
      signal: ledger.abortController.signal,
      onGroup: (id, state) => {
        ledger.recordGroup(id, state);
        if (state === "started") {
          pgid = id;
          ledger.abort("SIGTERM");
        }
      },
    });
    await expect(child).rejects.toThrow(/aborted/u);
    await new Promise((resolve) => {
      setTimeout(resolve, 30);
    });
    expect(pgid).toBeTypeOf("number");
    expect(processGroupAbsent(pgid!)).toBe(true);
    expect(ledger.activeGroups()).toEqual([]);
  });

  it("clears delay timers across completion/abort races", async () => {
    vi.useFakeTimers();
    try {
      const completedController = new AbortController();
      const completed = abortableDelay(100, completedController.signal);
      await vi.advanceTimersByTimeAsync(100);
      await expect(completed).resolves.toBeUndefined();
      completedController.abort(new Error("late abort"));
      expect(vi.getTimerCount()).toBe(0);

      const abortedController = new AbortController();
      const aborted = abortableDelay(100, abortedController.signal);
      abortedController.abort(new Error("race abort"));
      await expect(aborted).rejects.toThrow(/race abort/u);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects default-port execution evidence and wrong CLI status", () => {
    const context = createStackContext({
      root: "/candidate",
      head: "a".repeat(40),
      tree: "b".repeat(40),
      runId: "same-external-id",
      nonce: "c".repeat(32),
      runtimeBase: "/runtime",
      receiptPath: "/receipt.json",
      ports: resolveHostPorts({}, 1200),
    });
    const evidence = new ExecutedBindings();
    for (const [name, target] of Object.entries(evidence.expected(context))) {
      if (name !== "orchestrator") evidence.record(name, target);
    }
    evidence.record("orchestrator", "http://127.0.0.1:3100/healthz");
    expect(() => evidence.assertComplete(context)).toThrow(/expected candidate/u);
    expect(() => decodeTerminalCliStatus('{"run":{"run_id":"decoy","status":"completed"}}', "candidate")).toThrow(
      /expected candidate/u,
    );
    expect(() => decodeTerminalCliStatus('{"run":{"run_id":"candidate","status":"running"}}', "candidate")).toThrow(
      /not terminal/u,
    );
  });

  it("redacts credentials and private keys from retained errors and Compose logs", () => {
    const secret = "sk-or-v1-super-secret-value";
    const privateKey = "-----BEGIN OPENSSH PRIVATE KEY-----\nraw-private-material\n-----END OPENSSH PRIVATE KEY-----";
    const raw = `DATABASE_URL=postgres://user:password@host/db key=${secret}\n${privateKey}`;
    for (const sanitized of [safeError(new Error(raw)), sanitizeComposeLogs(raw)]) {
      expect(sanitized).not.toContain("password");
      expect(sanitized).not.toContain(secret);
      expect(sanitized).not.toContain("raw-private-material");
      expect(sanitized).toContain("<redacted>");
    }
  });
});
