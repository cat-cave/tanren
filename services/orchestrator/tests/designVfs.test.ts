import { describe, expect, it } from "vitest";
import {
  DesignVfs,
  DesignVfsCollisionError,
  DesignVfsMissingFileError,
  DesignVfsOperationError,
  DesignVfsPathError,
} from "../src/engine/design/system/designVfs.js";

const digest = (character: string): string => `sha256:${character.repeat(64)}`;

function file(path: string, kind: "tokens" | "asset" | "catalog" = "tokens") {
  return { path, kind, mediaType: "application/json", digest: digest("a"), byteSize: 1 } as const;
}

describe("DesignVfs", () => {
  it("exposes a stable read-only DesignVfsView over constrained additions", () => {
    const vfs = new DesignVfs();
    vfs.addCatalogRoute(file("catalog/index.json", "catalog"));
    vfs.addTokenSet(file("tokens/base.tokens.json"));

    expect(vfs.files.map((entry) => entry.path)).toEqual(["catalog/index.json", "tokens/base.tokens.json"]);
    expect(vfs.fileAt("tokens/base.tokens.json")?.kind).toBe("tokens");
    expect(vfs.fileAt("missing.json")).toBeUndefined();
  });

  it("fails loudly when an operation attempts an out-of-contract file kind", () => {
    const vfs = new DesignVfs();
    expect(() => vfs.addMode(file("assets/logo.svg", "asset"))).toThrow(DesignVfsOperationError);
  });

  it("fails loudly on unsafe paths and case-insensitive collisions", () => {
    const vfs = new DesignVfs();
    expect(() => vfs.addTokenSet(file("../escape.tokens.json"))).toThrow(DesignVfsPathError);
    vfs.addTokenSet(file("tokens/Colors.tokens.json"));
    expect(() => vfs.addTokenSet(file("tokens/colors.tokens.json"))).toThrow(DesignVfsCollisionError);
  });

  it("distinguishes a missing file from an empty artifact file", () => {
    const vfs = new DesignVfs();
    expect(() => vfs.read("tokens/missing.tokens.json")).toThrow(DesignVfsMissingFileError);
  });
});
