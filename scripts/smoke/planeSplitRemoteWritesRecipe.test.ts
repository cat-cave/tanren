import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const recipeName = "smoke-plane-split-worker-remote-writes";
const execFileAsync = promisify(execFile);

async function remoteWritesRecipe(): Promise<string> {
  const justfile = await readFile(new URL("../../justfile", import.meta.url), "utf8");
  const start = justfile.indexOf(`${recipeName}:`);
  const end = justfile.indexOf("\n# ", start);
  if (start < 0 || end < 0) throw new Error(`${recipeName} recipe is missing`);
  return justfile.slice(start, end);
}

async function runRemoteWritesProbe(env: NodeJS.ProcessEnv): Promise<Record<string, string>> {
  const { stdout } = await execFileAsync(
    "bash",
    [new URL("./plane-split-worker-remote-writes.sh", import.meta.url).pathname],
    { env: { ...process.env, ...env, TANREN_SMOKE_REMOTE_WRITES_DRY_RUN: "1" } },
  );
  return Object.fromEntries(
    stdout
      .trim()
      .split("\n")
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)] as [string, string];
      }),
  );
}

describe("remote-writes smoke recipe", () => {
  it("delivers the offset-derived data-plane URL to the deprivilege probe", async () => {
    const recipe = await remoteWritesRecipe();
    const probe = await runRemoteWritesProbe({ TANREN_PORT_OFFSET: "1965" });

    expect(recipe).toContain("bash scripts/smoke/plane-split-worker-remote-writes.sh");
    expect(probe).toMatchObject({
      TANREN_DATAPLANE_DATABASE_URL: "postgres://REDACTED@localhost:7397/tanren",
      TANREN_PLANE_SPLIT_PROVE_DEPRIVILEGE: "1",
      TANREN_SMOKE_REMOTE_WRITES_PROBE: "scripts/smoke/plane-split-worker.ts",
    });
  });

  it("preserves an explicit data-plane URL override for the deprivilege probe", async () => {
    const override = "postgres://u/name:p@ss@localhost:7999/probe?sslmode=require&x=a=b";
    const probe = await runRemoteWritesProbe({
      TANREN_DATAPLANE_DATABASE_URL: override,
      TANREN_PORT_OFFSET: "1965",
    });

    expect(probe).toMatchObject({
      TANREN_DATAPLANE_DATABASE_URL: "postgres://REDACTED@localhost:7999/probe?sslmode=require&x=a=b",
      TANREN_PLANE_SPLIT_PROVE_DEPRIVILEGE: "1",
    });
  });

  it("normalizes leading-zero host overrides and preserves @ in URL queries", async () => {
    const probe = await runRemoteWritesProbe({
      TANREN_INTERNAL_MTLS_HOST_PORT: "08000",
      TANREN_POSTGRES_HOST_PORT: "08001",
      TANREN_DATAPLANE_DATABASE_URL: "postgres://u/name:p@ss@localhost:8001/probe?x=a@b#frag",
    });
    expect(probe.TANREN_DATAPLANE_DATABASE_URL).toBe("postgres://REDACTED@localhost:8001/probe?x=a@b#frag");
  });

  it("does not treat an @ in a host path as credentials", async () => {
    for (const url of ["postgres://localhost/db/path@foo", "postgres://db/path@foo", "postgres://db?x=a@b"]) {
      const probe = await runRemoteWritesProbe({ TANREN_DATAPLANE_DATABASE_URL: url });
      expect(probe.TANREN_DATAPLANE_DATABASE_URL).toBe(url);
    }
  });
});
