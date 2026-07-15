import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { STAGE_REGISTRY } from "./stack-gates.js";
import {
  bindRuntimeEnvironment,
  findAvailablePorts,
  processGroupAbsent,
  resolveRuntimeBinding,
  waitForJsonHealth,
} from "./stack-runtime.js";

// cspell:ignore pids

const servers: Server[] = [];
const temporaryRoots: string[] = [];

async function listen(
  body: unknown,
  options: { status?: number; location?: string } = {},
): Promise<{ url: string; requests: () => number }> {
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(options.status ?? 200, {
      "content-type": "application/json",
      ...(options.location === undefined ? {} : { location: options.location }),
    });
    response.end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server exposed no TCP port");
  return { url: `http://127.0.0.1:${address.port}/healthz`, requests: () => requestCount };
}

async function temporaryRoot(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `tanren-${name}-`));
  temporaryRoots.push(root);
  return root;
}

async function initCleanRepository(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  execFileSync("git", ["init", "-q", root]);
  await writeFile(join(root, "tracked"), "clean\n");
  execFileSync("git", ["-C", root, "add", "tracked"]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.name=Smoke",
    "-c",
    "user.email=smoke@example.invalid",
    "commit",
    "-qm",
    "clean",
  ]);
}

async function waitUntil(check: () => Promise<boolean>, message: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 20);
    });
  }
  throw new Error(message);
}

function waitForExit(child: ChildProcess, waitMs: number): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("coordinator did not exit")), waitMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

/** Deterministic operator AbortSignal: fires after N polls (no wall-clock timing, no
 * infinite loop). A permanently-not-ready candidate is a fixed point, not a cycle, so the
 * operator signal fences it — the negative control for the dead/redirect candidates. */
function operatorFence(pollsBeforeAbort: number): { signal: AbortSignal; sleep: () => Promise<void> } {
  const controller = new AbortController();
  let polls = 0;
  return {
    signal: controller.signal,
    sleep: async () => {
      polls += 1;
      if (polls >= pollsBeforeAbort) controller.abort(new Error("candidate never converged within the operator fence"));
    },
  };
}

/** A candidate that returns 503 until `flip()` makes it semantically healthy. */
async function listenUntilReady(ready: unknown): Promise<{ url: string; flip: () => void }> {
  let healthy = false;
  const server = createServer((_request, response) => {
    if (healthy) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(ready));
    } else {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false }));
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server exposed no TCP port");
  return { url: `http://127.0.0.1:${address.port}/healthz`, flip: () => (healthy = true) };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("exact-stack smoke coordinator", () => {
  it("fails a dead candidate while a healthy default-port decoy remains untouched", async () => {
    const decoy = await listen({ ok: true, database: "ok", vault: { ok: true } });
    // A dead port reports the same ECONNREFUSED on every poll: a permanent fixed
    // point, not a cycle. The operator AbortSignal terminates the wait (no
    // wall-clock timeout); the healthy default-port decoy is never probed.
    const fence = operatorFence(2);
    await expect(
      waitForJsonHealth("orchestrator", "http://127.0.0.1:1/healthz", { delayMs: 0, ...fence }),
    ).rejects.toThrow(/never converged|ECONNREFUSED/u);
    expect(decoy.requests()).toBe(0);
  });

  it("rejects a candidate redirect without following the healthy decoy", async () => {
    const decoy = await listen({ ok: true, database: "ok", vault: { ok: true } });
    const candidate = await listen({}, { status: 302, location: decoy.url });
    // The redirect is re-reported on every poll (fetch redirect:"error"); it is a
    // permanent not-ready state fenced by the operator AbortSignal. fetchExact never
    // follows it, so the healthy decoy stays untouched.
    const fence = operatorFence(2);
    await expect(waitForJsonHealth("orchestrator", candidate.url, { delayMs: 0, ...fence })).rejects.toThrow(
      /never converged|redirect/u,
    );
    expect(candidate.requests()).toBeGreaterThan(0);
    expect(decoy.requests()).toBe(0);
  });

  it("waits through repeated identical not-ready probes and resolves once semantic health appears", async () => {
    // Generic wait / container-stabilization negative control matching the receipt
    // shape: two identical wrong-URL/not-ready signatures do NOT throw a cycle; the
    // wait continues and resolves the moment the candidate turns semantically green.
    // A permanent URL mismatch is the rebind postcondition's responsibility (covered
    // in stack-stages.test.ts), not the progress wait's.
    const candidate = await listenUntilReady({ ok: true, database: "ok", vault: { ok: true } });
    let polls = 0;
    const body = await waitForJsonHealth("orchestrator", candidate.url, {
      delayMs: 0,
      sleep: async () => {
        polls += 1;
        if (polls >= 2) candidate.flip();
      },
    });
    expect(body).toEqual({ ok: true, database: "ok", vault: { ok: true } });
  });

  it("delegates dynamic ports and binds one explicit or auto-discovered runtime", async () => {
    expect(findAvailablePorts({}, "same-id")).toEqual({
      orchestrator: 0,
      internalMtls: 0,
      allocator: 0,
      postgres: 0,
      runnerSsh: 0,
      vault: 0,
      dashboard: 0,
      ntfy: 0,
      registry: 0,
    });
    await expect(
      resolveRuntimeBinding(
        { PATH: "/bin" },
        { isSocket: async () => true, executable: async (name) => `/bin/${name}` },
      ),
    ).rejects.toThrow(/both required/u);
    const runtime = await resolveRuntimeBinding(
      { PATH: "/bin", TANREN_SMOKE_RUNTIME: "docker", TANREN_SMOKE_RUNTIME_SOCKET: "/runtime/docker.sock" },
      { isSocket: async () => true, executable: async (name) => `/bin/${name}` },
    );
    const env = bindRuntimeEnvironment({ DOCKER_CONTEXT: "decoy", CONTAINER_HOST: "ssh://decoy" }, runtime);
    expect(env).toMatchObject({ DOCKER_HOST: "unix:///runtime/docker.sock" });
    expect(env["DOCKER_CONTEXT"]).toBeUndefined();
    expect(env["CONTAINER_HOST"]).toBeUndefined();
  });

  it("enters the protected bootstrap through a shell-poison-resistant just boundary", async () => {
    const root = process.cwd();
    const temp = await temporaryRoot("shell-poison");
    const bin = join(temp, "bin");
    await mkdir(bin);
    const marker = join(temp, "poison-sourced");
    const sentinel = join(temp, "tool-ran");
    const poison = join(temp, "poison.sh");
    await writeFile(poison, `printf poison > ${JSON.stringify(marker)}\nexit 97\n`);
    const fakeCorepack = join(bin, "corepack");
    await writeFile(
      fakeCorepack,
      '#!/bin/sh\n[ -z "${BASH_ENV+x}" ] && [ -z "${ENV+x}" ] || exit 98\nprintf clean > "$SMOKE_SENTINEL"\n',
    );
    await chmod(fakeCorepack, 0o755);
    const result = spawnSync("just", ["--justfile", join(root, "justfile"), "smoke"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        BASH_ENV: poison,
        ENV: poison,
        SMOKE_SENTINEL: sentinel,
      },
    });
    expect(result.status).toBe(0);
    expect(await readFile(sentinel, "utf8")).toBe("clean");
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    const recipe = /^smoke:\n(?:  .*\n)+/mu.exec(await readFile(join(root, "justfile"), "utf8"))?.[0] ?? "";
    expect(recipe).toContain("scripts/smoke/stack-bootstrap.ts");
    expect(recipe).not.toContain("run-stack.ts");
  });

  it("dirty preflight emits exactly one requested failure receipt before runtime mutation", async () => {
    const base = await temporaryRoot("dirty-candidate");
    const candidate = join(base, "candidate");
    await initCleanRepository(candidate);
    await writeFile(join(candidate, "dirty"), "untracked\n");
    const runtimeBase = join(base, "runtime");
    const receipt = join(base, "dirty-receipt.json");
    const script = join(process.cwd(), "scripts", "smoke", "stack-bootstrap.ts");
    const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), script], {
      cwd: candidate,
      encoding: "utf8",
      env: { ...process.env, TANREN_SMOKE_RUNTIME_BASE: runtimeBase, TANREN_SMOKE_RECEIPT_PATH: receipt },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/clean committed worktree/u);
    expect(JSON.parse(await readFile(receipt, "utf8"))).toMatchObject({ status: "failed", cleanup: "completed" });
    expect((await readdir(base)).filter((name) => name.endsWith("receipt.json"))).toEqual(["dirty-receipt.json"]);
    await expect(stat(join(runtimeBase, "smoke"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("loads the smoke coordinator from the verified commit archive instead of the checkout", async () => {
    const base = await temporaryRoot("archive-execution");
    const candidate = join(base, "candidate");
    await initCleanRepository(candidate);
    // The clean source materializes its own dependencies from the repo lockfile;
    // a minimal frozen-lockfile fixture lets the real install succeed offline.
    await writeFile(join(candidate, "package.json"), '{"name":"smoke-archive-fixture","private":true}\n');
    await writeFile(
      join(candidate, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n",
    );
    await mkdir(join(candidate, "scripts", "smoke"), { recursive: true });
    await writeFile(
      join(candidate, "scripts", "smoke", "run-stack.ts"),
      `import { rm, writeFile } from "node:fs/promises";\n` +
        `export async function runPreparedSmoke(prepared: any): Promise<number> {\n` +
        `  await writeFile(process.env.TEST_PROOF!, JSON.stringify({ moduleUrl: import.meta.url, executionRoot: prepared.context.executionRoot, checkoutRoot: prepared.context.root, head: prepared.context.head, tree: prepared.context.tree, bootstrapInstall: prepared.bootstrapInstall }));\n` +
        `  await writeFile(prepared.context.receiptPath, JSON.stringify({ status: "passed", context: { nonce: prepared.context.nonce } }));\n` +
        `  prepared.signalState.sealed = true;\n` +
        `  await rm(prepared.buildBase, { recursive: true, force: true });\n` +
        `  return 0;\n` +
        `}\n`,
    );
    execFileSync("git", ["-C", candidate, "add", "package.json", "pnpm-lock.yaml", "scripts/smoke/run-stack.ts"]);
    execFileSync("git", [
      "-C",
      candidate,
      "-c",
      "user.name=Smoke",
      "-c",
      "user.email=smoke@example.invalid",
      "commit",
      "-qm",
      "coordinator fixture",
    ]);
    const proofPath = join(base, "archive-proof.json");
    const receipt = join(base, "archive-receipt.json");
    const result = spawnSync(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), join(process.cwd(), "scripts", "smoke", "stack-bootstrap.ts")],
      {
        cwd: candidate,
        encoding: "utf8",
        env: {
          ...process.env,
          TEST_PROOF: proofPath,
          TANREN_SMOKE_RUNTIME_BASE: join(base, "runtime"),
          TANREN_SMOKE_RECEIPT_PATH: receipt,
        },
      },
    );
    expect(result.status).toBe(0);
    const proof = JSON.parse(await readFile(proofPath, "utf8")) as {
      moduleUrl: string;
      executionRoot: string;
      checkoutRoot: string;
      head: string;
      tree: string;
      bootstrapInstall?: {
        command: { executable: string; args: string[]; cwd: string };
        status: string;
        groupStarted: boolean;
        groupExited: boolean;
        startedAt: string;
        finishedAt?: string;
      };
    };
    const modulePath = fileURLToPath(proof.moduleUrl);
    expect(modulePath).not.toContain(candidate);
    expect(modulePath).toBe(join(proof.executionRoot, "scripts", "smoke", "run-stack.ts"));
    expect(proof.checkoutRoot).toBe(candidate);
    expect(proof.head).toBe(execFileSync("git", ["-C", candidate, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
    expect(proof.tree).toBe(
      execFileSync("git", ["-C", candidate, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim(),
    );
    // The prepared coordinator observes the complete bootstrapInstall evidence: the
    // stack-bootstrap → PreparedSmokeRun → coordinator link is intact.
    expect(proof.bootstrapInstall).toBeDefined();
    expect(proof.bootstrapInstall!.status).toBe("passed");
    expect(proof.bootstrapInstall!.command.cwd).toBe(proof.executionRoot);
    expect(proof.bootstrapInstall!.command.executable).toMatch(/^\//u);
    expect(proof.bootstrapInstall!.command.args).toContain("--frozen-lockfile");
    expect(proof.bootstrapInstall!.command.args).toContain("--prefer-offline");
    expect(proof.bootstrapInstall!.groupStarted).toBe(true);
    expect(proof.bootstrapInstall!.groupExited).toBe(true);
    expect(proof.bootstrapInstall!.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(proof.bootstrapInstall!.finishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(JSON.parse(await readFile(receipt, "utf8"))).toMatchObject({ status: "passed" });
  }, 30_000);

  it("emits a failure receipt with bootstrap.install when frozen-lockfile install drifts", async () => {
    const base = await temporaryRoot("lockfile-drift-bootstrap");
    const candidate = join(base, "candidate");
    await initCleanRepository(candidate);
    // Lockfile drifts from package.json: a dependency is declared but absent from the lockfile.
    // pnpm --frozen-lockfile fails immediately without fetching packages.
    await writeFile(
      join(candidate, "package.json"),
      '{"name":"smoke-drift","private":true,"dependencies":{"express":"^4.0.0"}}\n',
    );
    await writeFile(
      join(candidate, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n",
    );
    execFileSync("git", ["-C", candidate, "add", "package.json", "pnpm-lock.yaml"]);
    execFileSync("git", [
      "-C",
      candidate,
      "-c",
      "user.name=Smoke",
      "-c",
      "user.email=smoke@example.invalid",
      "commit",
      "-qm",
      "drift",
    ]);
    const receipt = join(base, "drift-receipt.json");
    const result = spawnSync(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), join(process.cwd(), "scripts", "smoke", "stack-bootstrap.ts")],
      {
        cwd: candidate,
        encoding: "utf8",
        env: {
          ...process.env,
          TANREN_SMOKE_RUNTIME_BASE: join(base, "runtime"),
          TANREN_SMOKE_RECEIPT_PATH: receipt,
          DATABASE_URL: "postgres://secret-user:secret-password@secret-host/secret-db",
        },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/lockfile|OUTDATED_LOCKFILE/iu);
    const failure = JSON.parse(await readFile(receipt, "utf8")) as {
      status: string;
      bootstrap?: {
        install?: {
          command: { executable: string; args: string[]; cwd: string };
          startedAt: string;
          finishedAt?: string;
          pgid?: number;
          groupStarted: boolean;
          groupExited: boolean;
          status: string;
          error?: string;
        };
      };
    };
    expect(failure.status).toBe("failed");
    // The bootstrap-failure publisher link is intact: bootstrap.install is in the receipt.
    // Removing the link from the bootstrap-failure publisher breaks this assertion.
    expect(failure.bootstrap?.install).toBeDefined();
    const install = failure.bootstrap!.install!;
    expect(install.command.executable).toMatch(/^\//u);
    expect(install.command.args).toContain("--frozen-lockfile");
    expect(install.command.args).toContain("--prefer-offline");
    expect(install.command.args.join(" ")).toMatch(/--store-dir \S+/u);
    // Exact clean-source cwd: inside the owned build base, never the candidate checkout.
    expect(install.command.cwd).toMatch(/tanren-smoke-source/u);
    expect(install.command.cwd.endsWith("source")).toBe(true);
    expect(install.command.cwd).not.toContain(candidate);
    expect(install.pgid).toBeTypeOf("number");
    expect(install.groupStarted).toBe(true);
    expect(install.groupExited).toBe(true);
    expect(install.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(install.finishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(install.status).toBe("failed");
    expect(install.error).toMatch(/lockfile|OUTDATED_LOCKFILE/iu);
    // No environment or secrets are recorded in the bootstrap evidence.
    const json = JSON.stringify(install);
    expect(json).not.toContain("secret-user");
    expect(json).not.toContain("secret-password");
    expect(json).not.toContain("DATABASE_URL");
  }, 30_000);

  it("SIGTERM during a hung bootstrap Git tree fences its whole PGID and emits one receipt", async () => {
    const base = await temporaryRoot("preflight-signal");
    const candidate = join(base, "candidate");
    await initCleanRepository(candidate);
    const bin = join(base, "bin");
    await mkdir(bin);
    const pidFile = join(base, "child-process-ids");
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const fakeGit = join(bin, "git");
    await writeFile(
      fakeGit,
      "#!/bin/sh\n" +
        'root=""; if [ "$1" = "-C" ]; then root="$2"; shift 2; fi\n' +
        'case "$1" in\n' +
        "  status) echo $$ >> \"$PID_FILE\"; \"$REAL_NODE\" -e \"const {spawn}=require('child_process');spawn(process.execPath,['-e','setInterval(()=>{},1e3)'],{stdio:'ignore'});setInterval(()=>{},1e3)\" ;;\n" +
        '  *) if [ -n "$root" ]; then exec "$REAL_GIT" -C "$root" "$@"; else exec "$REAL_GIT" "$@"; fi ;;\n' +
        "esac\n",
    );
    await chmod(fakeGit, 0o755);
    const receipt = join(base, "signal.json");
    const child = spawn(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), join(process.cwd(), "scripts", "smoke", "stack-bootstrap.ts")],
      {
        cwd: candidate,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env["PATH"] ?? ""}`,
          REAL_GIT: realGit,
          REAL_NODE: process.execPath,
          PID_FILE: pidFile,
          TANREN_SMOKE_RUNTIME_BASE: join(base, "runtime"),
          TANREN_SMOKE_RECEIPT_PATH: receipt,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    try {
      await waitUntil(
        async () => (await readFile(pidFile, "utf8").catch(() => "")).trim() !== "",
        "Git child never started",
      );
      child.kill("SIGTERM");
      expect(await waitForExit(child, 8_000)).toBe(143);
      const earlyReceipt = join(tmpdir(), "tanren-smoke-receipts", `bootstrap-bootstrap-${child.pid}.json`);
      expect(JSON.parse(await readFile(earlyReceipt, "utf8"))).toMatchObject({ status: "failed" });
      await rm(earlyReceipt, { force: true });
      const pids = (await readFile(pidFile, "utf8")).trim().split(/\s+/u).map(Number);
      for (const pid of pids) expect(processGroupAbsent(pid)).toBe(true);
    } finally {
      child.kill("SIGKILL");
    }
  }, 15_000);

  it("retains the unique 56-stage production registry", () => {
    const names = STAGE_REGISTRY.map((stage) => stage.name);
    expect(names).toHaveLength(56);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining(["publish-receipt", "seed-platform-credentials"]));
  });
});
