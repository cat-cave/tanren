import { describe, expect, it } from "vitest";
import {
  CiConfigValidationError,
  CiYamlParseError,
  DEFAULT_CI_CONFIG,
  JUNIT_REPORT_PATH,
  bootstrapCommand,
  parseYaml,
  resolveCiConfig,
  stepsFor,
  tiersFor,
} from "../src/engine/ci/index.js";

const VALID = `version: 1
bootstrap:
  run: "pnpm install --frozen-lockfile"
tiers:
  fast:
    - name: lint
      run: "pnpm lint"
    - name: typecheck
      run: "pnpm typecheck"
  slow:
    - name: build
      run: "pnpm build"
when:
  fast:
    - per_iteration
  slow:
    - pre_audit
    - pre_merge
`;

function expectValidationError(yamlText: string): CiConfigValidationError {
  try {
    resolveCiConfig(yamlText);
  } catch (error) {
    if (error instanceof CiConfigValidationError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected resolveCiConfig to throw CiConfigValidationError");
}

describe("resolveCiConfig — missing", () => {
  it("returns the frozen, STACK-AGNOSTIC 3-tier default when no file is present", () => {
    const cfg = resolveCiConfig();
    expect(cfg).toBe(DEFAULT_CI_CONFIG);
    // Three tiers, mapped 1:1 to the three lifecycle points (3-tier CI requirement).
    expect(Object.keys(cfg.tiers).toSorted()).toEqual(["fast", "merge", "slow"]);
    // Every step defers to `just <target>` — Tanren names NO stack (no pnpm/npm/node).
    const allRuns = Object.values(cfg.tiers).flatMap((steps) => steps.map((s) => s.run));
    for (const run of [...allRuns, bootstrapCommand(cfg) ?? ""]) {
      expect(run).toMatch(/^just /u);
      expect(run).not.toMatch(/pnpm|npm|corepack|node/u);
    }
    // tier-1 (fast) → `just tier-1`; tier-2 (slow) → `just tier-2`; tier-3 (merge) → `just tier-3`.
    expect(cfg.tiers.fast.map((s) => s.run)).toEqual(["just tier-1"]);
    expect(cfg.tiers.slow.map((s) => s.run)).toEqual(["just tier-2"]);
    expect(cfg.tiers.merge?.map((s) => s.run)).toEqual(["just tier-3"]);
    // bootstrap defers to `just bootstrap` (the project owns its stack's install).
    expect(bootstrapCommand(cfg)).toBe("just bootstrap");
  });

  it("keeps the JUnit report-path convention fixed for the per-test ingest", () => {
    // The COMMAND that writes the report is the project's (`just tier-2`), but the
    // OUTPUT path the ingest (`ingestGateJunit`) reads back stays fixed.
    expect(JUNIT_REPORT_PATH).toBe("reports/junit.xml");
  });

  it("maps fast→per_iteration, slow→pre_audit, merge→pre_merge (3 distinct tiers)", () => {
    expect(tiersFor(DEFAULT_CI_CONFIG, "per_iteration")).toEqual(["fast"]);
    expect(tiersFor(DEFAULT_CI_CONFIG, "pre_audit")).toEqual(["slow"]);
    expect(tiersFor(DEFAULT_CI_CONFIG, "pre_merge")).toEqual(["merge"]);
  });
});

describe("resolveCiConfig — valid", () => {
  it("parses a well-formed config", () => {
    const cfg = resolveCiConfig(VALID);
    expect(cfg.version).toBe(1);
    expect(cfg.tiers.fast).toHaveLength(2);
    expect(cfg.tiers.slow[0]).toEqual({ name: "build", run: "pnpm build" });
    expect(bootstrapCommand(cfg)).toBe("pnpm install --frozen-lockfile");
  });

  it("resolves when-policy to tiers per lifecycle point", () => {
    const cfg = resolveCiConfig(VALID);
    expect(tiersFor(cfg, "per_iteration")).toEqual(["fast"]);
    expect(tiersFor(cfg, "pre_audit")).toEqual(["slow"]);
    expect(tiersFor(cfg, "pre_merge")).toEqual(["slow"]);
  });

  it("flattens steps for a lifecycle point in tier then step order", () => {
    const cfg = resolveCiConfig(VALID);
    expect(stepsFor(cfg, "per_iteration").map((s) => s.name)).toEqual(["lint", "typecheck"]);
    expect(stepsFor(cfg, "pre_merge").map((s) => s.name)).toEqual(["build"]);
  });

  it("orders extra named tiers after fast and slow, alphabetically", () => {
    const withExtra = `version: 1
tiers:
  fast:
    - name: lint
      run: pnpm lint
  slow:
    - name: build
      run: pnpm build
  zeta:
    - name: z
      run: run-z
  alpha:
    - name: a
      run: run-a
when:
  fast:
    - per_iteration
  slow:
    - pre_merge
  zeta:
    - pre_audit
  alpha:
    - pre_audit
`;
    const cfg = resolveCiConfig(withExtra);
    expect(Object.keys(cfg.tiers).toSorted()).toEqual(["alpha", "fast", "slow", "zeta"]);
    expect(tiersFor(cfg, "pre_audit")).toEqual(["alpha", "zeta"]);
  });

  it("treats bootstrap as optional", () => {
    const noBootstrap = `version: 1
tiers:
  fast:
    - name: lint
      run: pnpm lint
  slow:
    - name: build
      run: pnpm build
when:
  fast:
    - per_iteration
  slow:
    - pre_merge
`;
    expect(bootstrapCommand(resolveCiConfig(noBootstrap))).toBeUndefined();
  });
});

describe("resolveCiConfig — invalid (fails loudly)", () => {
  it("rejects a wrong version literal", () => {
    const err = expectValidationError(VALID.replace("version: 1", "version: 2"));
    expect(err).toBeInstanceOf(CiConfigValidationError);
  });

  it("rejects a missing required tier", () => {
    const noSlow = `version: 1
tiers:
  fast:
    - name: lint
      run: pnpm lint
when:
  fast:
    - per_iteration
`;
    expect(() => resolveCiConfig(noSlow)).toThrow(CiConfigValidationError);
  });

  it("rejects an empty tier step list", () => {
    const emptyTier = `version: 1
tiers:
  fast:
    - name: lint
      run: pnpm lint
  slow: []
when:
  fast:
    - per_iteration
  slow:
    - pre_merge
`;
    // A degenerate `slow: []` is not a step list; it must fail loudly rather
    // than resolve to a tier that silently runs nothing.
    expect(() => resolveCiConfig(emptyTier)).toThrow(CiConfigValidationError);
  });

  it("rejects an unknown lifecycle point in the when policy", () => {
    const err = expectValidationError(VALID.replace("- per_iteration", "- bogus_point"));
    expect(err.issues.length).toBeGreaterThan(0);
  });

  it("rejects a when policy that references an undeclared tier", () => {
    const extraWhen = `${VALID}  ghost:\n    - pre_merge\n`;
    const err = expectValidationError(extraWhen);
    expect(err.message).toContain("unknown tier");
  });

  it("rejects a tier with no when policy entry", () => {
    const unmapped = `version: 1
tiers:
  fast:
    - name: lint
      run: pnpm lint
  slow:
    - name: build
      run: pnpm build
when:
  fast:
    - per_iteration
`;
    const err = expectValidationError(unmapped);
    expect(err.message).toContain("no when policy entry");
  });

  it("rejects unknown top-level keys (strict)", () => {
    expect(() => resolveCiConfig(`${VALID}extra: nope\n`)).toThrow(CiConfigValidationError);
  });

  // §3.12: every tier is mapped, but NONE to pre_merge. `runGateForWhen("pre_merge")` would
  // return a passing EMPTY verdict (a vacuous pass = the merge authority lands anything), so
  // the config MUST fail closed rather than authorize an un-gated merge.
  it("rejects a config that leaves pre_merge UNCOVERED (vacuous-pass merge authority)", () => {
    const noPreMerge = `version: 1
tiers:
  fast:
    - name: lint
      run: pnpm lint
  slow:
    - name: build
      run: pnpm build
when:
  fast:
    - per_iteration
  slow:
    - pre_audit
`;
    const err = expectValidationError(noPreMerge);
    expect(err.message).toContain("pre_merge");
  });
});

describe("YAML parser", () => {
  it("returns an empty mapping for blank/comment-only input", () => {
    expect(parseYaml("")).toEqual({});
    expect(parseYaml("# just a comment\n")).toEqual({});
  });

  it("strips inline comments outside quotes", () => {
    const parsed = parseYaml(`version: 1 # trailing\nrun: "a # b"\n`) as Record<string, unknown>;
    expect(parsed.version).toBe(1);
    expect(parsed.run).toBe("a # b");
  });

  it("rejects tab indentation", () => {
    expect(() => parseYaml("tiers:\n\tfast: x")).toThrow(CiYamlParseError);
  });

  // §3.12: a tab in the leading INDENTATION is forbidden even when the line is deeper —
  // the reject is on the indentation region, not "any line that contains a tab".
  it("rejects a tab in the indentation of an indented line", () => {
    expect(() => parseYaml("tiers:\n  fast:\n  \tnested: x")).toThrow(CiYamlParseError);
  });

  // §3.12: a tab INSIDE a quoted value (content, not indentation) is VALID — the old check
  // false-rejected any indented line containing a tab anywhere.
  it("allows a literal tab inside a quoted value on an indented line", () => {
    const parsed = parseYaml('outer:\n  run: "a\tb"\n') as Record<string, Record<string, unknown>>;
    expect(parsed.outer.run).toBe("a\tb");
  });

  // §3.12: a duplicate mapping key must FAIL LOUDLY (the old last-wins silently shadowed the
  // earlier value — a writer-editable ci.yml could redefine pre_merge coverage unnoticed).
  it("rejects a duplicate mapping key (no silent last-wins)", () => {
    expect(() => parseYaml("a: 1\nb: 2\na: 3\n")).toThrow(/duplicate mapping key/u);
  });

  it("rejects documents that do not start at column 0", () => {
    expect(() => parseYaml("  version: 1")).toThrow(CiYamlParseError);
  });

  it("parses scalars: numbers, booleans, null, bare and quoted strings", () => {
    const parsed = parseYaml(`a: 1\nb: true\nc: null\nd: bare words\ne: "quoted"\n`) as Record<string, unknown>;
    expect(parsed).toEqual({ a: 1, b: true, c: null, d: "bare words", e: "quoted" });
  });
});
