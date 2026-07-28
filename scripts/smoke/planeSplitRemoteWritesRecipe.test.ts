import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const script = new URL("./plane-split-worker-remote-writes.sh", import.meta.url).pathname;
const justfile = new URL("../../justfile", import.meta.url);

async function dryRun(env: NodeJS.ProcessEnv): Promise<Record<string, string>> {
  const { stdout } = await execFileAsync("bash", [script], {
    env: { ...process.env, ...env, TANREN_SMOKE_REMOTE_WRITES_DRY_RUN: "1" },
  });
  return Object.fromEntries(
    stdout
      .trim()
      .split("\n")
      .map((line) => line.split("=", 2) as [string, string]),
  );
}

describe("remote-writes smoke recipe", () => {
  it("uses explicit URLs and offset-derived data-plane port end-to-end", async () => {
    const explicit = "postgres://tanren:pw@localhost:5532/tanren";
    const probe = await dryRun({
      DATABASE_URL: explicit,
      TANREN_APP_DATABASE_URL: explicit,
      TANREN_PORT_OFFSET: "100",
    });
    expect(probe).toMatchObject({
      TANREN_DATAPLANE_DATABASE_URL: "postgres://localhost:5532/tanren",
      DATABASE_URL: "postgres://localhost:5532/tanren",
      TANREN_APP_DATABASE_URL: "postgres://localhost:5532/tanren",
    });
    expect(await readFile(justfile, "utf8")).toContain(
      "bash scripts/smoke/plane-split-worker-remote-writes.sh --validate",
    );
  });

  it("accepts a valid explicit URL during the pre-compose validation phase", async () => {
    await expect(
      execFileAsync("bash", [script, "--validate"], {
        env: {
          ...process.env,
          DATABASE_URL: "postgres://user:secret@localhost:5532/tanren",
          TANREN_PORT_OFFSET: "100",
        },
      }),
    ).resolves.toMatchObject({ stdout: "" });
  });

  it("rejects malformed URLs and offsets before any probe", async () => {
    await expect(dryRun({ DATABASE_URL: "postgres://localhost/no-port", TANREN_PORT_OFFSET: "100" })).rejects.toThrow(
      /explicit postgres URL/u,
    );
    await expect(dryRun({ TANREN_PORT_OFFSET: "-1" })).rejects.toThrow(/TANREN_PORT_OFFSET/u);
  });
});
