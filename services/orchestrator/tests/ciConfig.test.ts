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
  it("returns the frozen 3-tier default when no file is present", () => {
    const cfg = resolveCiConfig();
    expect(cfg).toBe(DEFAULT_CI_CONFIG);
    // Three tiers, mapped 1:1 to the three lifecycle points (3-tier CI requirement).
    expect(Object.keys(cfg.tiers).toSorted()).toEqual(["fast", "merge", "slow"]);
    // tier-1 (fast) is cheap: lint + typecheck ONLY — NO tests in the per-iteration tier.
    expect(cfg.tiers.fast.map((s) => s.name)).toEqual(["lint", "typecheck"]);
    expect(cfg.tiers.fast.some((s) => s.name === "unit" || /test/u.test(s.run))).toBe(false);
    // tier-2 (slow) is build + tests at spec completion.
    expect(cfg.tiers.slow.map((s) => s.name)).toEqual(["build", "test"]);
    // tier-3 (merge) is the heaviest thorough gate.
    expect(cfg.tiers.merge?.map((s) => s.name)).toEqual(["lint", "typecheck", "build", "test"]);
  });

  it("emits JUnit evidence from the test tiers to the path the per-test ingest reads", () => {
    const cfg = DEFAULT_CI_CONFIG;
    // The JUnit ingest (`ingestGateJunit`) reads back exactly `reports/junit.xml`.
    expect(JUNIT_REPORT_PATH).toBe("reports/junit.xml");
    for (const tier of ["slow", "merge"] as const) {
      const testStep = (cfg.tiers[tier] ?? []).find((s) => s.name === "test");
      expect(testStep).toBeDefined();
      expect(testStep?.run).toContain("--reporter=junit");
      expect(testStep?.run).toContain(`--outputFile=${JUNIT_REPORT_PATH}`);
    }
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

  it("rejects documents that do not start at column 0", () => {
    expect(() => parseYaml("  version: 1")).toThrow(CiYamlParseError);
  });

  it("parses scalars: numbers, booleans, null, bare and quoted strings", () => {
    const parsed = parseYaml(`a: 1\nb: true\nc: null\nd: bare words\ne: "quoted"\n`) as Record<string, unknown>;
    expect(parsed).toEqual({ a: 1, b: true, c: null, d: "bare words", e: "quoted" });
  });
});
