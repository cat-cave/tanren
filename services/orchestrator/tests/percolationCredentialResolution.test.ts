// Percolation credential-resolution loud-failure tests (no-silent-fallbacks fix).
//
// The percolation detect resolves the GitHub credential (App installation + static
// ref) from the project/org config blobs before reading ancestor head SHAs. The
// prior helpers swallowed a malformed config to `undefined` (disabling App auth) or
// quietly skipped a malformed project config to the org default — a silent degrade
// that would read ancestors with a static/unauthenticated token (or none). Per the
// binding doctrine a PRESENT-yet-UNPARSEABLE config is a LOUD failure: the
// `migrate*Config` parse error PROPAGATES. Only a genuinely ABSENT (`null`/
// `undefined`) config or a parseable config with no credential configured is the
// legitimate "no credential" empty result.

import { describe, expect, it } from "vitest";
import { percolationCredentialResolutionInternals } from "../src/engine/dag/percolationPg.js";
import { UnknownConfigVersionError } from "../src/engine/config/shared.js";

const { orgGithubApp, githubStaticRef } = percolationCredentialResolutionInternals;

describe("percolation orgGithubApp — no silent fallback", () => {
  it("returns undefined for a genuinely ABSENT org config (legitimate 'no App')", () => {
    const absent: unknown = undefined;
    expect(orgGithubApp(null)).toBeUndefined();
    expect(orgGithubApp(absent)).toBeUndefined();
  });

  it("returns undefined for a parseable App-less org config (legitimate 'no App')", () => {
    expect(orgGithubApp({ version: 1 })).toBeUndefined();
  });

  it("THROWS loudly on a PRESENT-yet-UNPARSEABLE org config — never a silent undefined that disables App auth", () => {
    // A versionless (corrupt) config: the old code swallowed this to `undefined`,
    // silently disabling App auth. It must now throw loudly.
    expect(() => orgGithubApp({ github_app: { installationId: "123" } })).toThrow(UnknownConfigVersionError);
  });
});

describe("percolation githubStaticRef — no silent fallback", () => {
  it("returns the project credential ref when the project config carries one", () => {
    const ref = githubStaticRef(
      { version: 1, credentials: { githubCredentialRef: "credential/github/project" } },
      { version: 1 },
    );
    expect(ref).toBe("credential/github/project");
  });

  it("falls through to the org default when the project config is ABSENT", () => {
    expect(githubStaticRef(null, { version: 1, defaultCredentials: { github_token: "credential/github/org" } })).toBe(
      "credential/github/org",
    );
  });

  it("returns undefined when neither project nor org config configures a ref (legitimate empty)", () => {
    expect(githubStaticRef({ version: 1 }, { version: 1 })).toBeUndefined();
    expect(githubStaticRef(null, null)).toBeUndefined();
  });

  it("THROWS loudly on a PRESENT-yet-UNPARSEABLE project config — never swallowed-and-skipped to the org default", () => {
    // The old code caught this and quietly fell through to the org default, masking
    // a corrupt project config. It must now throw loudly.
    expect(() =>
      githubStaticRef(
        { credentials: { githubCredentialRef: "credential/github/project" } },
        { version: 1, defaultCredentials: { github_token: "credential/github/org" } },
      ),
    ).toThrow(UnknownConfigVersionError);
  });

  it("THROWS loudly on a PRESENT-yet-UNPARSEABLE org config — never swallowed to undefined", () => {
    expect(() => githubStaticRef({ version: 1 }, { defaultCredentials: { github_token: "x" } })).toThrow(
      UnknownConfigVersionError,
    );
  });
});
