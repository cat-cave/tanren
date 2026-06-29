// Audit finding H2 — `deriveImplicitDependsOn` covers only addPackageJsonDep
// /addPackageJsonDevDep. The constrained `FragmentOp` subset also includes
// `{ kind: "write" | "overwrite", path, content }` (could write package.json /
// Gemfile directly, bypassing the addPackageJsonDep API) and `{ kind: "just",
// target, lines }` (could append pnpm / node / bundle / ruby commands into a
// just target). A fragment that calls `vfs.write("package.json", "...")` or
// `vfs.appendToJustfileTarget("dev", ["pnpm run dev"])` would derive
// `dependsOn: []` and silently pair with the wrong runtime — exactly the
// "silently dropping deps" pattern audit #11 was meant to close.
//
// The doctrine: any fragment whose ops imply a runtime MUST declare that
// runtime as a `dependsOn`. The composer's existing
// `dependency_runtime_mismatch` then fails LOUD on a misaligned pair instead
// of producing a quietly-broken composed VFS.

import { describe, expect, it } from "vitest";
import { deriveImplicitDependsOn } from "../src/engine/templates/fragments/fragmentAuthoringRun.js";
import type { FragmentOp, FragmentSpec } from "../src/engine/templates/index.js";

const addonSpec: FragmentSpec = {
  kind: "addon",
  label: "spellcheck",
  id: "addon-spellcheck",
  requiredContract: {},
};

const runtimeSpec: FragmentSpec = {
  kind: "runtime",
  label: "node-pnpm",
  id: "runtime-node-pnpm",
  requiredContract: {},
};

describe("deriveImplicitDependsOn — addPackageJsonDep / addPackageJsonDevDep (audit finding #11)", () => {
  it("derives runtime-node-pnpm when any op is addPackageJsonDep", () => {
    const ops: FragmentOp[] = [{ kind: "dep", name: "react", version: "^19.0.0" }];
    expect(deriveImplicitDependsOn(ops, addonSpec)).toEqual(["runtime-node-pnpm"]);
  });

  it("derives runtime-node-pnpm when any op is addPackageJsonDevDep", () => {
    const ops: FragmentOp[] = [{ kind: "devDep", name: "vitest", version: "^4.0.0" }];
    expect(deriveImplicitDependsOn(ops, addonSpec)).toEqual(["runtime-node-pnpm"]);
  });

  it("derives EMPTY when no op implies a runtime (a docs-only addon, vfs.write to a non-runtime path)", () => {
    const ops: FragmentOp[] = [{ kind: "write", path: "docs/spellcheck.md", content: "spellcheck addon\n" }];
    expect(deriveImplicitDependsOn(ops, addonSpec)).toEqual([]);
  });
});

describe("deriveImplicitDependsOn — vfs.write/overwrite path-keyed runtime derivation (audit finding H2)", () => {
  it("derives runtime-node-pnpm when the body writes package.json DIRECTLY (bypasses addPackageJsonDep)", () => {
    // A fragment whose `vfs.write("package.json", "...")` would compose a
    // package.json into the VFS WITHOUT going through addPackageJsonDep. The
    // derivation MUST notice and surface the node runtime — otherwise the
    // fragment would pair silently with a Ruby runtime and the composed
    // scaffold would carry both a Gemfile and a package.json with no node
    // tooling to run the latter.
    const ops: FragmentOp[] = [
      { kind: "write", path: "package.json", content: '{"name":"x","version":"0.0.0"}' },
    ];
    expect(deriveImplicitDependsOn(ops, addonSpec)).toEqual(["runtime-node-pnpm"]);
  });

  it("derives runtime-node-pnpm when the body OVERWRITES package.json", () => {
    const ops: FragmentOp[] = [
      { kind: "overwrite", path: "package.json", content: '{"name":"x","version":"0.0.0"}' },
    ];
    expect(deriveImplicitDependsOn(ops, addonSpec)).toEqual(["runtime-node-pnpm"]);
  });

  it("derives runtime-ruby-bundler when the body writes Gemfile DIRECTLY", () => {
    const ops: FragmentOp[] = [{ kind: "write", path: "Gemfile", content: "source 'https://rubygems.org'\n" }];
    expect(deriveImplicitDependsOn(ops, addonSpec)).toEqual(["runtime-ruby-bundler"]);
  });

  it("derives runtime-ruby-bundler when the body OVERWRITES Gemfile", () => {
    const ops: FragmentOp[] = [
      { kind: "overwrite", path: "Gemfile", content: "source 'https://rubygems.org'\n" },
    ];
    expect(deriveImplicitDependsOn(ops, addonSpec)).toEqual(["runtime-ruby-bundler"]);
  });

  it("does NOT derive a runtime for a write to an unrelated path (the doctrine is path-keyed, not 'any write')", () => {
    const ops: FragmentOp[] = [
      { kind: "write", path: "docs/README.md", content: "hello\n" },
      { kind: "overwrite", path: "src/index.ts", content: "export {};\n" },
    ];
    expect(deriveImplicitDependsOn(ops, addonSpec)).toEqual([]);
  });
});

describe("deriveImplicitDependsOn — appendToJustfileTarget tooling-token derivation (audit finding H2)", () => {
  it("derives runtime-node-pnpm when a just line invokes pnpm", () => {
    const ops: FragmentOp[] = [{ kind: "just", target: "dev", lines: ["pnpm run dev"] }];
    expect(deriveImplicitDependsOn(ops, addonSpec)).toEqual(["runtime-node-pnpm"]);
  });

  it("derives runtime-node-pnpm when a just line invokes npm / npx / yarn / node", () => {
    const npmOps: FragmentOp[] = [{ kind: "just", target: "ci", lines: ["npm ci"] }];
    expect(deriveImplicitDependsOn(npmOps, addonSpec)).toEqual(["runtime-node-pnpm"]);
    const npxOps: FragmentOp[] = [{ kind: "just", target: "lint", lines: ["npx eslint ."] }];
    expect(deriveImplicitDependsOn(npxOps, addonSpec)).toEqual(["runtime-node-pnpm"]);
    const yarnOps: FragmentOp[] = [{ kind: "just", target: "install", lines: ["yarn install --frozen-lockfile"] }];
    expect(deriveImplicitDependsOn(yarnOps, addonSpec)).toEqual(["runtime-node-pnpm"]);
    const nodeOps: FragmentOp[] = [{ kind: "just", target: "start", lines: ["node dist/main.js"] }];
    expect(deriveImplicitDependsOn(nodeOps, addonSpec)).toEqual(["runtime-node-pnpm"]);
  });

  it("derives runtime-ruby-bundler when a just line invokes bundle / gem / ruby", () => {
    const bundleOps: FragmentOp[] = [{ kind: "just", target: "bootstrap", lines: ["bundle install"] }];
    expect(deriveImplicitDependsOn(bundleOps, addonSpec)).toEqual(["runtime-ruby-bundler"]);
    const gemOps: FragmentOp[] = [{ kind: "just", target: "install", lines: ["gem install bundler"] }];
    expect(deriveImplicitDependsOn(gemOps, addonSpec)).toEqual(["runtime-ruby-bundler"]);
    const rubyOps: FragmentOp[] = [{ kind: "just", target: "test", lines: ["ruby test/run_all.rb"] }];
    expect(deriveImplicitDependsOn(rubyOps, addonSpec)).toEqual(["runtime-ruby-bundler"]);
  });

  it("token-matches as WHOLE words, not substrings (e.g. `snpm` does NOT match `npm`)", () => {
    // A defensive check: a path/token containing the substring `npm` (e.g. `snpm`)
    // should NOT trigger node-pnpm derivation. The regex requires the token to be
    // bounded by start/end OR a whitespace/punctuation neighbor.
    const ops: FragmentOp[] = [{ kind: "just", target: "build", lines: ["mkdir snpm-output"] }];
    expect(deriveImplicitDependsOn(ops, addonSpec)).toEqual([]);
  });

  it("aggregates DISTINCT implied runtimes when a fragment mixes node + ruby tokens", () => {
    // A pathological fragment authoring both pnpm + bundle into different targets:
    // the derivation MUST surface BOTH runtimes (the composer's runtime-mismatch
    // check then fires loud because the slot can only hold ONE runtime). The Set
    // dedupes so a single runtime never appears twice.
    const ops: FragmentOp[] = [
      { kind: "just", target: "node-side", lines: ["pnpm install"] },
      { kind: "just", target: "ruby-side", lines: ["bundle install"] },
      { kind: "dep", name: "react", version: "^19.0.0" },
    ];
    const result = deriveImplicitDependsOn(ops, addonSpec);
    expect(new Set(result)).toEqual(new Set(["runtime-node-pnpm", "runtime-ruby-bundler"]));
    expect(result).toHaveLength(2);
  });

  it("a justfile line with NO recognized tooling token implies no runtime", () => {
    const ops: FragmentOp[] = [{ kind: "just", target: "format", lines: ["echo formatting...", "true"] }];
    expect(deriveImplicitDependsOn(ops, addonSpec)).toEqual([]);
  });
});

describe("deriveImplicitDependsOn — runtime fragments never imply a self-dependency", () => {
  it("a runtime fragment that writes its OWN package.json does NOT self-derive runtime-node-pnpm", () => {
    // A runtime fragment IS the runtime — synthesizing a `runtime-node-pnpm`
    // dependsOn on itself would be a cycle. The early-return guards this even
    // when the runtime body's ops would otherwise imply the runtime.
    const ops: FragmentOp[] = [
      { kind: "write", path: "package.json", content: '{"name":"x"}' },
      { kind: "just", target: "bootstrap", lines: ["pnpm install"] },
      { kind: "dep", name: "vitest", version: "^4.0.0" },
    ];
    expect(deriveImplicitDependsOn(ops, runtimeSpec)).toEqual([]);
  });
});
