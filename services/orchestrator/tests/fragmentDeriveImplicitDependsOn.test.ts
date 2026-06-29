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
    const ops: FragmentOp[] = [{ kind: "write", path: "package.json", content: '{"name":"x","version":"0.0.0"}' }];
    expect(deriveImplicitDependsOn(ops, addonSpec)).toEqual(["runtime-node-pnpm"]);
  });

  it("derives runtime-node-pnpm when the body OVERWRITES package.json", () => {
    const ops: FragmentOp[] = [{ kind: "overwrite", path: "package.json", content: '{"name":"x","version":"0.0.0"}' }];
    expect(deriveImplicitDependsOn(ops, addonSpec)).toEqual(["runtime-node-pnpm"]);
  });

  it("derives runtime-ruby-bundler when the body writes Gemfile DIRECTLY", () => {
    const ops: FragmentOp[] = [{ kind: "write", path: "Gemfile", content: "source 'https://rubygems.org'\n" }];
    expect(deriveImplicitDependsOn(ops, addonSpec)).toEqual(["runtime-ruby-bundler"]);
  });

  it("derives runtime-ruby-bundler when the body OVERWRITES Gemfile", () => {
    const ops: FragmentOp[] = [{ kind: "overwrite", path: "Gemfile", content: "source 'https://rubygems.org'\n" }];
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

  it("token-matches as WHOLE words, not substrings (a token EMBEDDED in another word does NOT match)", () => {
    // A defensive check: a word containing one of the runtime tokens as a
    // SUBSTRING (e.g. `linode` contains `node`, `cathode` contains `node`) MUST
    // NOT trigger derivation. The regex requires the token to be bounded by
    // start/end OR a whitespace/punctuation neighbor on BOTH sides.
    const ops: FragmentOp[] = [
      { kind: "just", target: "build", lines: ["mkdir output"] },
      { kind: "just", target: "deploy", lines: ["ssh linode-host echo ok"] },
    ];
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

describe("deriveImplicitDependsOn — justfile comment lines do NOT false-positive the token match (task #103)", () => {
  // Justfile / shell comments are `#` to end-of-line. A line whose tooling
  // token lives INSIDE a comment must NOT derive a runtime — otherwise a
  // fragment that documents history (`# we used to use pnpm here`) or adds an
  // inline comment (`mkdir output # was: npm init`) falsely flags as needing
  // the node / ruby runtime, then pairs wrong with the surrounding template.
  // The audit found `lineHasNodeToolingToken` matched whole-line comments AND
  // trailing comments; both must now strip the comment portion first.
  it("a whole-line comment containing pnpm / npm / yarn / npx / node does NOT derive runtime-node-pnpm", () => {
    const ops: FragmentOp[] = [
      { kind: "just", target: "docs", lines: ["# we used to use pnpm here"] },
      { kind: "just", target: "history", lines: ["# npm was deprecated in v3"] },
      { kind: "just", target: "history", lines: ["# yarn install removed"] },
      { kind: "just", target: "history", lines: ["# npx replaced"] },
      { kind: "just", target: "history", lines: ["# node binary path now resolves via mise"] },
    ];
    expect(deriveImplicitDependsOn(ops, addonSpec)).toEqual([]);
  });

  it("a whole-line comment containing bundle / gem / ruby does NOT derive runtime-ruby-bundler", () => {
    const ops: FragmentOp[] = [
      { kind: "just", target: "docs", lines: ["# bundle install was here pre-migration"] },
      { kind: "just", target: "history", lines: ["# gem install bundler — now mise-managed"] },
      { kind: "just", target: "history", lines: ["# ruby version pinned in .tool-versions"] },
    ];
    expect(deriveImplicitDependsOn(ops, addonSpec)).toEqual([]);
  });

  it("a TRAILING comment (code + ` # …`) ignores tokens after the `#`", () => {
    // The code BEFORE the `#` is a real command — `mkdir output` has no
    // tooling token, so the line implies no runtime even though the comment
    // names every tooling token. Strip first, then match.
    const ops: FragmentOp[] = [
      { kind: "just", target: "build", lines: ["mkdir output # was: pnpm build, npm run build, yarn build"] },
      { kind: "just", target: "build", lines: ["true # bundle / gem / ruby were here"] },
    ];
    expect(deriveImplicitDependsOn(ops, addonSpec)).toEqual([]);
  });

  it("a TRAILING comment does NOT mask a REAL tooling invocation on the same line", () => {
    // The code before the `#` IS a real `pnpm install` — the derive must still
    // see it. The strip removes only the comment, not the leading command.
    const ops: FragmentOp[] = [{ kind: "just", target: "bootstrap", lines: ["pnpm install # historical npm note"] }];
    expect(deriveImplicitDependsOn(ops, addonSpec)).toEqual(["runtime-node-pnpm"]);
  });

  it("indented whole-line comments are also stripped (justfile bodies are indented)", () => {
    // A justfile recipe body is conventionally indented; a comment LINE inside
    // a recipe starts with whitespace then `#`. The strip rule (`#` preceded
    // by whitespace) covers this case too.
    const ops: FragmentOp[] = [{ kind: "just", target: "docs", lines: ["    # pnpm install was here"] }];
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
