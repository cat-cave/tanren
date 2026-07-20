import { describe, expect, it } from "vitest";
import { FragmentLibrary, VirtualFileSystem, type Fragment } from "../src/engine/templates/fragments/types.js";

function fragment(id: string, dependsOn: readonly string[] = []): Fragment {
  return {
    id,
    kind: "runtime",
    label: id.slice("runtime-".length),
    version: "1.0.0",
    contract: {},
    dependsOn,
    apply: async () => {},
  } as never;
}

describe("fragment composition fail-closed guards", () => {
  it("rejects absent files and non-object JSON instead of fabricating composition inputs", () => {
    const vfs = new VirtualFileSystem();

    expect(() => vfs.read(".tanren/evidence-contract.json")).toThrow(/is not present/u);
    vfs.write(".tanren/evidence-contract.json", "[]");
    expect(() => vfs.mergeJson(".tanren/evidence-contract.json", (current) => current)).toThrow(/not valid JSON/u);
  });

  it("rejects duplicate, unresolved, and cyclic fragment dependencies before compose can apply them", () => {
    const library = new FragmentLibrary();
    const base = fragment("runtime-base");
    library.register(base);
    expect(() => library.register(base)).toThrow(/duplicate fragment id/u);
    expect(() => library.replaceForTests(fragment("runtime-missing"))).toThrow(/not registered/u);
    expect(() => library.require("runtime-missing")).toThrow(/no fragment registered/u);
    expect(() => library.resolveOrder([fragment("runtime-a", ["runtime-missing"])])).toThrow(/depends on missing/u);
    expect(() =>
      library.resolveOrder([fragment("runtime-a", ["runtime-b"]), fragment("runtime-b", ["runtime-a"])]),
    ).toThrow(/dependency cycle/u);

    expect(
      library
        .resolveOrder([base, fragment("runtime-a", ["runtime-base"]), fragment("runtime-b", ["runtime-base"])])
        .map((f) => f.id),
    ).toEqual(["runtime-base", "runtime-a", "runtime-b"]);
  });
});
