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
      .map((line) => line.split("=", 2) as [string, string]),
  );
}

describe("remote-writes smoke recipe", () => {
  it("delivers the offset-derived data-plane URL to the deprivilege probe", async () => {
    const recipe = await remoteWritesRecipe();
    const probe = await runRemoteWritesProbe({ TANREN_PORT_OFFSET: "1965" });

    expect(recipe).toContain("bash scripts/smoke/plane-split-worker-remote-writes.sh");
    expect(probe).toMatchObject({
      TANREN_DATAPLANE_DATABASE_URL: "postgres://tanren_dataplane:tanren_dataplane@localhost:7397/tanren",
      TANREN_PLANE_SPLIT_PROVE_DEPRIVILEGE: "1",
      TANREN_SMOKE_REMOTE_WRITES_PROBE: "scripts/smoke/plane-split-worker.ts",
    });
  });

  it("preserves an explicit data-plane URL override for the deprivilege probe", async () => {
    const override = "postgres://tenant_probe:secret@localhost:7999/probe";
    const probe = await runRemoteWritesProbe({
      TANREN_DATAPLANE_DATABASE_URL: override,
      TANREN_PORT_OFFSET: "1965",
    });

    expect(probe).toMatchObject({
      TANREN_DATAPLANE_DATABASE_URL: override,
      TANREN_PLANE_SPLIT_PROVE_DEPRIVILEGE: "1",
    });
  });
});
