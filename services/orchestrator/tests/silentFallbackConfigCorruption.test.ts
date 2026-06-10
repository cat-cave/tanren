// no_silent_fallbacks doctrine — the config-corruption swallow cluster.
//
// Each formerly-silent catch over a `migrateProjectConfig` parse is now one of two
// loud behaviors, asserted here:
//   - PROPAGATE where a swallow would yield WRONG behavior (wrong github identity /
//     wrong batch cap): a present-but-CORRUPT project config throws, rather than
//     silently falling through to the org-default token or the default cap.
//   - LOUD-DEFAULT where a safe default is genuinely correct (the walker's
//     speculation eagerness knob; governance `strict`): the safe default is kept,
//     but the corruption is logged + (for the walker) surfaced as an observability
//     event — never a bare silent catch.
//
// The absent-vs-corrupt distinction is load-bearing: an ABSENT project config (the
// `'{}'::jsonb` default a fresh project carries, or any blob with no `version`) is
// NOT corruption and legitimately falls through to the org default / schema default.

import { afterEach, describe, expect, it, vi } from "vitest";
import { isAbsentProjectConfig } from "../src/engine/config/index.js";
import { resolveGithubStaticRef as resolveGithubStaticRefSpeculative } from "../src/engine/dag/speculativeIntegrator.js";
import {
  resolveGithubStaticRef as resolveGithubStaticRefBatch,
  resolveGovernancePosture,
} from "../src/engine/merge/batchChecker.js";

// A present-but-CORRUPT project config: a `version` the parser does not support.
const CORRUPT_PROJECT_CONFIG = { version: 99 } as const;
// A present-but-CORRUPT V1 body: claims version 1 but fails the V1 schema.
const CORRUPT_V1_BODY = { version: 1, governancePosture: "not-a-posture" } as const;
// An ABSENT config: the DB column default a fresh project carries.
const ABSENT_PROJECT_CONFIG = {} as const;

// A present-but-CORRUPT ORG config: an unsupported version. The project config is
// ABSENT here so resolution legitimately reaches the org-default branch — which
// must PROPAGATE the corruption, never swallow it to a silent undefined that
// quietly disables GitHub creds.
const CORRUPT_ORG_CONFIG = { version: 99 } as const;

const ORG_CONFIG_WITH_DEFAULT = {
  version: 1,
  defaultCredentials: { github_token: "credential/github/org-default" },
} as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isAbsentProjectConfig — the propagate-vs-fall-through pivot", () => {
  it("treats null / {} / a version-less blob / a missing row as ABSENT (not corruption)", () => {
    // A missing `projects.config` row reads back as `undefined`; bind it through a
    // typed value so the lint stays clean while still exercising the undefined case.
    const missingRow: unknown = undefined as unknown;
    expect(isAbsentProjectConfig(null)).toBe(true);
    expect(isAbsentProjectConfig(missingRow)).toBe(true);
    expect(isAbsentProjectConfig({})).toBe(true);
    expect(isAbsentProjectConfig({ governancePosture: "strict" })).toBe(true);
  });

  it("treats a present `version` (even an unsupported one) as PRESENT (corruption-checkable)", () => {
    expect(isAbsentProjectConfig({ version: 1 })).toBe(false);
    expect(isAbsentProjectConfig({ version: 99 })).toBe(false);
  });
});

describe("resolveGithubStaticRef — PROPAGATE on a corrupt project config (wrong-identity guard)", () => {
  for (const [name, resolve] of [
    ["speculativeIntegrator", resolveGithubStaticRefSpeculative],
    ["batchChecker", resolveGithubStaticRefBatch],
  ] as const) {
    it(`${name}: THROWS on a corrupt project config instead of using the org-default token`, () => {
      // An unsupported version → UnknownConfigVersionError.
      expect(() => resolve(CORRUPT_PROJECT_CONFIG, ORG_CONFIG_WITH_DEFAULT)).toThrow(/unknown config version/iu);
      // A version:1 body that fails the V1 schema → a Zod parse error (non-empty message).
      expect(() => resolve(CORRUPT_V1_BODY, ORG_CONFIG_WITH_DEFAULT)).toThrow(/\S/u);
    });

    it(`${name}: an ABSENT project config falls through to the org default (legitimate)`, () => {
      expect(resolve(ABSENT_PROJECT_CONFIG, ORG_CONFIG_WITH_DEFAULT)).toBe("credential/github/org-default");
    });

    it(`${name}: a clean project config with a bound ref returns that ref`, () => {
      const projectConfig = { version: 1, credentials: { githubCredentialRef: "credential/github/project" } };
      expect(resolve(projectConfig, ORG_CONFIG_WITH_DEFAULT)).toBe("credential/github/project");
    });

    it(`${name}: PROPAGATES on a corrupt ORG config (never silently disables creds)`, () => {
      // Project config ABSENT → resolution falls through to the org default,
      // where a present-but-unparseable org config must THROW (loud, fail-closed),
      // not be swallowed to undefined.
      expect(() => resolve(ABSENT_PROJECT_CONFIG, CORRUPT_ORG_CONFIG)).toThrow(/unknown config version/iu);
    });

    it(`${name}: an ABSENT org config resolves to undefined (legitimate "no org default")`, () => {
      // A missing `organizations.config` reads back as `undefined`; bind it through a
      // typed value so the lint stays clean while still exercising the undefined case.
      const missingOrgConfig: unknown = undefined as unknown;
      expect(resolve(ABSENT_PROJECT_CONFIG, null)).toBeUndefined();
      expect(resolve(ABSENT_PROJECT_CONFIG, missingOrgConfig)).toBeUndefined();
    });
  }
});

describe("resolveGovernancePosture — LOUD default `strict` on a corrupt config", () => {
  it("returns the fail-closed `strict` default AND logs (never a silent catch)", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(resolveGovernancePosture(CORRUPT_PROJECT_CONFIG)).toBe("strict");
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.join(" ")).toMatch(/governance posture/iu);
  });

  it("reads the real posture from a clean config (no warn)", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(resolveGovernancePosture({ version: 1, governancePosture: "lenient" })).toBe("lenient");
    expect(warn).not.toHaveBeenCalled();
  });
});
