import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const recipeName = "smoke-plane-split-worker-remote-writes";

async function remoteWritesRecipe(): Promise<string> {
  const justfile = await readFile(new URL("../../justfile", import.meta.url), "utf8");
  const start = justfile.indexOf(`${recipeName}:`);
  const end = justfile.indexOf("\n# ", start);
  if (start < 0 || end < 0) throw new Error(`${recipeName} recipe is missing`);
  return justfile.slice(start, end);
}

describe("remote-writes smoke recipe", () => {
  it("routes the data-plane negative proof through the derived offset Postgres port", async () => {
    const recipe = await remoteWritesRecipe();
    const offsetPort = 7397;
    const dataPlaneAssignment =
      'TANREN_DATAPLANE_DATABASE_URL="${TANREN_DATAPLANE_DATABASE_URL:-postgres://tanren_dataplane:tanren_dataplane@localhost:${postgres_port}/tanren}"';

    expect(recipe).toContain('postgres_port="${TANREN_POSTGRES_HOST_PORT:-$((5432 + ${TANREN_PORT_OFFSET:-0}))}"');
    expect(recipe).toContain("TANREN_PLANE_SPLIT_PROVE_DEPRIVILEGE=1");
    expect(recipe).toContain(dataPlaneAssignment);
    expect(dataPlaneAssignment.replace("${postgres_port}", String(offsetPort))).toContain("localhost:7397/tanren");
    expect(recipe).not.toContain(
      "TANREN_DATAPLANE_DATABASE_URL=postgres://tanren_dataplane:tanren_dataplane@localhost:5432",
    );
  });
});
