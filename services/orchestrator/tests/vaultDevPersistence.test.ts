// The dev Vault's PERSISTENCE contract, at the two seams that can silently break it.
//
// This stack's Vault moved from `server -dev` (in-memory, wiped on every restart)
// to a file backend on a named volume, so that the GitHub App key, the LLM router
// key, the proof-signing key and every per-org BYOK credential survive a restart.
// Durable state brings two failure modes that in-memory dev mode simply could not
// have, and both were live:
//
//   1. PID 1 exiting before Vault has flushed, which tears the file backend
//      mid-write — the one way to lose the store that `server -dev` could not.
//   2. A 0.0.0.0 publish of a Vault behind a fixed, documented root token. Cheap
//      while the secrets evaporated on restart; not cheap now that they do not.
//
// The shutdown case is driven end to end against the REAL entrypoint script with a
// stub `vault` on PATH — no mock of the code under test, and the stub's flush is
// slow on purpose so "did it wait" is observable rather than asserted.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const ENTRYPOINT = join(REPO_ROOT, "ops/vault/entrypoint.sh");
const COMPOSE = readFileSync(join(REPO_ROOT, "compose.dev.yml"), "utf8");
const JUSTFILE = readFileSync(join(REPO_ROOT, "justfile"), "utf8");

// A stand-in for the `vault` binary. `server` is the part that matters: it blocks,
// and on SIGTERM it takes a visible amount of time to "flush" before exiting 0 —
// exactly the window in which a PID 1 that does not wait destroys the store.
const VAULT_STUB = `#!/bin/sh
case "$1" in
  server)
    flushed=0
    trap 'flushed=1' TERM
    # Emulate a server that is draining, not one that dies instantly.
    i=0
    while [ "$flushed" -eq 0 ] && [ "$i" -lt 200 ]; do
      sleep 0.05
      i=$((i + 1))
    done
    sleep 1
    printf 'flushed\\n' > "$TANREN_TEST_FLUSH_MARKER"
    exit 0
    ;;
  status)
    printf 'Initialized true\\nSealed false\\n'
    exit 0
    ;;
  secrets)
    [ "$2" = "list" ] && printf 'secret/\\n'
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`;

const workspaces: string[] = [];

afterEach(() => {
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stubbedWorkspace(): { bin: string; marker: string } {
  const dir = mkdtempSync(join(tmpdir(), "tanren-vault-entrypoint-"));
  workspaces.push(dir);
  const stub = join(dir, "vault");
  writeFileSync(stub, VAULT_STUB);
  chmodSync(stub, 0o755);
  return { bin: dir, marker: join(dir, "flushed") };
}

describe("ops/vault/entrypoint.sh — PID 1 must outlive Vault's flush", () => {
  it("waits for the server to finish draining after SIGTERM, and exits with ITS status", async () => {
    const { bin, marker } = stubbedWorkspace();
    const child = spawn("sh", [ENTRYPOINT], {
      env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}`, TANREN_TEST_FLUSH_MARKER: marker },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Wait for the entrypoint to declare itself ready, so the SIGTERM lands on the
    // final `wait` rather than somewhere in the start-up sequence.
    await new Promise<void>((resolve, reject) => {
      let seen = "";
      child.stdout.on("data", (chunk: Buffer) => {
        seen += chunk.toString();
        if (seen.includes("ready - storage is persistent")) resolve();
      });
      child.on("exit", (code) => reject(new Error(`entrypoint exited early with ${String(code)}: ${seen}`)));
    });

    child.kill("SIGTERM");
    const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.on("exit", (code, signal) => resolve({ code, signal }));
    });

    // THE ASSERTION. Before the fix the trap forwarded SIGTERM and `set -e` then
    // exited on the interrupted `wait`'s 143, killing the container while the
    // server was still writing. Now PID 1 stays until the child has really reaped,
    // and reports the child's status so a genuine crash is still a crash.
    expect(exit.signal).toBeNull();
    expect(exit.code).toBe(0);
    // Non-vacuous: the marker only exists because the drain was allowed to finish.
    // A 143 exit would have raced past this.
    expect(existsSync(marker)).toBe(true);
  }, 30_000);
});

describe("the dev Vault's durable state is not published to the world", () => {
  it("binds the Vault host port to loopback by default", () => {
    // Vault is the one service in this file whose port must not default to 0.0.0.0:
    // it is a fixed-root-token Vault that now PERSISTS every platform credential.
    expect(COMPOSE).toContain('"${TANREN_VAULT_BIND_ADDR:-127.0.0.1}:${TANREN_VAULT_HOST_PORT:-18200}:8200"');
    // Non-vacuous: the un-bound form must be gone, not merely accompanied.
    expect(COMPOSE).not.toContain('"${TANREN_VAULT_HOST_PORT:-18200}:8200"');
  });

  it("keeps the Vault data on a named volume the compose file declares", () => {
    expect(COMPOSE).toContain("vaultdata:/vault/file");
  });
});

describe("stack-reset really does destroy the volumes it documents destroying", () => {
  it("runs `down -v` unconditionally, not behind a running-container probe", () => {
    const body = JUSTFILE.slice(JUSTFILE.indexOf("\nstack-reset:")).split("\n\n")[0] ?? "";
    // The EXECUTABLE lines only — the recipe's own comments explain the probe that
    // was removed, and an assertion that reads them proves nothing.
    const commands = body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#") && line !== "stack-reset:");
    expect(commands).toEqual(["docker compose -f compose.dev.yml down -v --remove-orphans"]);
    // `docker compose ps -q` lists RUNNING containers only, so gating the teardown
    // on it let a merely-stopped stack keep `vaultdata` through a "reset". The docs
    // tell operators this command destroys their credentials; it has to.
    expect(commands.join(" ")).not.toContain("ps -q");
  });
});
