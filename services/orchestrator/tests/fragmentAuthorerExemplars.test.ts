// EXEMPLAR END-TO-END PARSE PIN (fix/f2-exemplar-inline-literals — apex).
//
// The F2 authorer prompt embeds one exemplar per slot kind so the LLM sees a
// real, in-tree fragment shape. If any exemplar itself does not parse cleanly
// through `parseFragmentBody` + `interpretOrgFragment`, the writer's first
// attempt — a faithful imitation of the exemplar — is rejected, the rework loop
// spins, and the compound apex-blocking bug returns. This suite pins:
//
//   1. Every exemplar in `FRAGMENT_EXEMPLARS` parses cleanly through
//      `parseFragmentBody` (returns a non-empty op list — a silent 0-op parse
//      is the "NO-OP fragment" failure mode).
//   2. Every exemplar wires through `interpretOrgFragment` to produce a runnable
//      `Fragment` whose `.apply()` mutates a `VirtualFileSystem` without
//      throwing.
//   3. Each exemplar's parsed ops match the slot's declared responsibilities:
//        - runtime + backend + frontend + auth + example + db → writes files
//        - deploy → declares FLY_API_TOKEN + a deploy justfile line
//        - runtime → wires the test-runner dep + tier-2 justfile fill
//        - db → declares the migrations dir + DATABASE_URL
//   4. `exemplarFor("backend")` / `("auth")` / `("example")` no longer falls
//      back to the runtime exemplar — the writer for those slots must see a
//      shape that DOES NOT teach runtime concerns (Codex #7).

import { describe, expect, it } from "vitest";
import {
  exemplarFor,
  FRAGMENT_EXEMPLARS,
  FragmentKind,
  interpretOrgFragment,
  parseFragmentBody,
  VirtualFileSystem,
  type FragmentOp,
  type TemplateConfig,
} from "../src/engine/templates/index.js";

function parseExemplar(kind: FragmentKind): FragmentOp[] {
  return parseFragmentBody(exemplarFor(kind).source);
}

function opKinds(ops: readonly FragmentOp[]): string[] {
  return ops.map((op) => op.kind);
}

describe("fragmentAuthorerExemplars — every exemplar parses cleanly through parseFragmentBody", () => {
  for (const kind of FragmentKind.options) {
    it(`${kind} exemplar parses to a non-empty op list (no silent NO-OP fragment)`, () => {
      const ops = parseExemplar(kind);
      expect(ops.length).toBeGreaterThan(0);
    });
  }
});

describe("fragmentAuthorerExemplars — every exemplar wires through interpretOrgFragment", () => {
  const config: TemplateConfig = {
    slug: "exemplar-parse-pin",
    runtime: "runtime-node-pnpm",
    deploy: "deploy-fly",
    addons: [],
    examples: [],
  };
  for (const kind of FragmentKind.options) {
    it(`${kind} exemplar interprets + applies without throwing`, async () => {
      const exemplar = exemplarFor(kind);
      const fragment = interpretOrgFragment({
        fragmentId: `test-org:${exemplar.fragmentId}:1.0.0`,
        kind,
        label: exemplar.fragmentId,
        version: "1.0.0",
        bodyTs: exemplar.source,
        contract: {},
        dependsOn: [],
      });
      const vfs = new VirtualFileSystem();
      await fragment.apply(vfs, config);
      // Every exemplar produces at least one artifact — a file write or an env
      // var declaration or a package.json dep. A fragment that produces NOTHING
      // is doctrinally the silent NO-OP shape we are guarding against.
      const producedSomething =
        Object.keys(vfs.toFlatMap()).length > 0 ||
        vfs.collectedEnvVars().size > 0 ||
        vfs.collectedDeps().size > 0 ||
        vfs.collectedDevDeps().size > 0 ||
        vfs.justHookTargets().length > 0;
      expect(producedSomething).toBe(true);
    });
  }
});

describe("fragmentAuthorerExemplars — parsed ops match each slot's declared responsibilities", () => {
  it("runtime exemplar wires the vitest dep + tier-2 justfile fill", () => {
    const ops = parseExemplar("runtime");
    expect(opKinds(ops)).toContain("devDep");
    expect(opKinds(ops)).toContain("just");
    const vitest = ops.find(
      (op): op is FragmentOp & { kind: "devDep" } => op.kind === "devDep" && op.name === "vitest",
    );
    expect(vitest).toBeDefined();
    const tier2 = ops.find((op): op is FragmentOp & { kind: "just" } => op.kind === "just" && op.target === "tier-2");
    expect(tier2).toBeDefined();
  });

  it("deploy exemplar declares FLY_API_TOKEN + a deploy justfile line (owned by deploy slot)", () => {
    const ops = parseExemplar("deploy");
    const env = ops.find((op): op is FragmentOp & { kind: "env" } => op.kind === "env" && op.key === "FLY_API_TOKEN");
    expect(env).toBeDefined();
    const deployJust = ops.find(
      (op): op is FragmentOp & { kind: "just" } => op.kind === "just" && op.target === "deploy",
    );
    expect(deployJust).toBeDefined();
  });

  it("db exemplar declares DATABASE_URL + a schema file (owned by db slot)", () => {
    const ops = parseExemplar("db");
    const env = ops.find((op): op is FragmentOp & { kind: "env" } => op.kind === "env" && op.key === "DATABASE_URL");
    expect(env).toBeDefined();
    const schema = ops.find(
      (op): op is FragmentOp & { kind: "write" } => op.kind === "write" && op.path === "prisma/schema.prisma",
    );
    expect(schema).toBeDefined();
  });

  it("frontend exemplar writes app/root.tsx + declares framework deps", () => {
    const ops = parseExemplar("frontend");
    const root = ops.find(
      (op): op is FragmentOp & { kind: "write" } => op.kind === "write" && op.path === "app/root.tsx",
    );
    expect(root).toBeDefined();
    const dep = ops.find(
      (op): op is FragmentOp & { kind: "dep" } => op.kind === "dep" && op.name.startsWith("@remix-run/"),
    );
    expect(dep).toBeDefined();
  });

  it("addon exemplar writes a Dockerfile + .dockerignore, no product env vars", () => {
    const ops = parseExemplar("addon");
    const dockerfile = ops.find(
      (op): op is FragmentOp & { kind: "write" } => op.kind === "write" && op.path === "Dockerfile",
    );
    expect(dockerfile).toBeDefined();
    const noProductEnv = ops.every(
      (op) => op.kind !== "env" || (op.key !== "DATABASE_URL" && op.key !== "FLY_API_TOKEN"),
    );
    expect(noProductEnv).toBe(true);
  });

  it("backend exemplar wires a server framework + serve recipe, does NOT ship a test-runner config", () => {
    const ops = parseExemplar("backend");
    // A server-shaped exemplar writes a server.ts + a serve justfile hook.
    const server = ops.find(
      (op): op is FragmentOp & { kind: "write" } => op.kind === "write" && op.path === "src/server.ts",
    );
    expect(server).toBeDefined();
    const serveJust = ops.find(
      (op): op is FragmentOp & { kind: "just" } => op.kind === "just" && op.target === "serve",
    );
    expect(serveJust).toBeDefined();
    // Backend must NOT install a test runner or wire test-runner config — that's
    // the runtime fragment's job (Codex #7).
    const noTestRunnerConfig = ops.every(
      (op) => op.kind !== "write" || (op.path !== "vitest.config.ts" && op.path !== "jest.config.ts"),
    );
    expect(noTestRunnerConfig).toBe(true);
    const noVitestDep = ops.every(
      (op) => (op.kind !== "devDep" && op.kind !== "dep") || (op as { name?: string }).name !== "vitest",
    );
    expect(noVitestDep).toBe(true);
  });

  it("auth exemplar declares its OWN client-id/secret env vars, does NOT declare DATABASE_URL", () => {
    const ops = parseExemplar("auth");
    // Auth owns AUTH_* env vars.
    const authSecret = ops.find(
      (op): op is FragmentOp & { kind: "env" } => op.kind === "env" && op.key === "AUTH_SECRET",
    );
    expect(authSecret).toBeDefined();
    // Auth must NOT declare DATABASE_URL — that's the db fragment's job (Codex #7).
    const noDbUrl = ops.every((op) => op.kind !== "env" || op.key !== "DATABASE_URL");
    expect(noDbUrl).toBe(true);
    // Auth must NOT write a prisma schema — that's the db fragment's job.
    const noDbSchema = ops.every((op) => op.kind !== "write" || !op.path.startsWith("prisma/"));
    expect(noDbSchema).toBe(true);
  });

  it("example exemplar seeds product-shaped source + a meaningful test, does NOT overwrite runtime config", () => {
    const ops = parseExemplar("example");
    // Example seeds a product-shaped source file.
    const productSource = ops.find(
      (op): op is FragmentOp & { kind: "write" } => op.kind === "write" && op.path.startsWith("src/example/"),
    );
    expect(productSource).toBeDefined();
    // Example must NOT re-declare runtime config (Codex #7).
    const noRuntimeConfig = ops.every(
      (op) =>
        (op.kind !== "write" && op.kind !== "overwrite") ||
        (op.path !== "tsconfig.json" && op.path !== "package.json" && op.path !== "mise.toml"),
    );
    expect(noRuntimeConfig).toBe(true);
  });
});

describe("fragmentAuthorerExemplars — backend/auth/example no longer fall back to runtime (Codex #7)", () => {
  it("exemplarFor('backend') returns a backend-shaped exemplar, not the runtime fallback", () => {
    const exemplar = exemplarFor("backend");
    expect(exemplar.fragmentId).not.toBe("runtime-node-pnpm");
    expect(exemplar.fragmentId).toMatch(/backend/u);
  });

  it("exemplarFor('auth') returns an auth-shaped exemplar, not the runtime fallback", () => {
    const exemplar = exemplarFor("auth");
    expect(exemplar.fragmentId).not.toBe("runtime-node-pnpm");
    expect(exemplar.fragmentId).toMatch(/auth/u);
  });

  it("exemplarFor('example') returns an example-shaped exemplar, not the runtime fallback", () => {
    const exemplar = exemplarFor("example");
    expect(exemplar.fragmentId).not.toBe("runtime-node-pnpm");
    expect(exemplar.fragmentId).toMatch(/example/u);
  });

  it("FRAGMENT_EXEMPLARS covers every FragmentKind with a distinct exemplar id per non-base slot", () => {
    const ids = new Set<string>();
    for (const kind of FragmentKind.options) {
      // base intentionally reuses runtime — the shipped skeleton doesn't hit F2.
      if (kind === "base") continue;
      ids.add(FRAGMENT_EXEMPLARS[kind].fragmentId);
    }
    // 8 non-base kinds should have 8 distinct exemplar ids after the fallback removal.
    expect(ids.size).toBe(8);
  });
});

describe("fragmentAuthorerExemplars — exemplars use INLINE literal arguments (not identifiers)", () => {
  // Regression pin for the pre-fix pattern:
  //     const TSCONFIG = \`...\`;
  //     vfs.write("tsconfig.json", TSCONFIG);  // <-- parser rejects identifier
  //
  // Every exemplar must call vfs.write / addPackageJsonDep / addEnvVar / etc.
  // with LITERAL arguments (double-quoted or backtick), not with module-scope
  // const identifiers. The parser-passes assertions above already cover this
  // indirectly (an identifier arg throws at parseStringLiteral); this test pins
  // the surface directly so a regression is named at the exemplar level.
  for (const kind of FragmentKind.options) {
    it(`${kind} exemplar's apply() body does not reference a module-scope content const`, () => {
      const src = exemplarFor(kind).source;
      // Any `vfs.write("path", <BAREWORD>)` where <BAREWORD> is a SCREAMING_CASE
      // identifier is the pre-fix pattern. Match calls whose second arg is such
      // an identifier (not a literal).
      const badPattern = /vfs\.(write|overwrite)\s*\(\s*"[^"]*"\s*,\s*[A-Z][A-Z0-9_]{2,}\s*\)/u;
      expect(src).not.toMatch(badPattern);
    });
  }
});
