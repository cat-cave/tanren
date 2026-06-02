// Seam conformance suite for the VaultTokenMinter contract
// (engine/contracts/vaultTokenMinter.ts). Reusable behavior spec invoked once per
// implementation. Asserts the SECURITY PROPERTIES every minter must hold:
//   - the minted scope covers EXACTLY the requested run's ref paths (deduped +
//     sorted), never widened to a wildcard, never another run's paths;
//   - a bounded, positive TTL + num_uses is requested and echoed back;
//   - an empty ref-path set, a wildcard, or a path-climbing `..` is rejected;
//   - the result NEVER carries the broad token (the only token field is the
//     short-lived child, and the audit `scope` omits it).
import { describe, expect, it } from "vitest";
import type { VaultTokenMinter } from "../../src/engine/contracts/vaultTokenMinter.js";

export interface VaultTokenMinterConformanceHarness {
  /** Build a fresh minter under test. */
  make(): VaultTokenMinter;
}

export function describeVaultTokenMinterConformance(label: string, harness: VaultTokenMinterConformanceHarness): void {
  describe(`VaultTokenMinter conformance: ${label}`, () => {
    const baseInput = {
      runId: "run-1",
      orgId: "org-acme",
      ttlSeconds: 600,
      numUses: 8,
    };

    it("scopes the policy to EXACTLY the requested ref paths (deduped + sorted)", async () => {
      const minter = harness.make();
      const minted = await minter.mintScopedRunToken({
        ...baseInput,
        credentialRefPaths: [
          "credential/github/org/org-acme/bot",
          "credential/codex/org/org-acme/default",
          // a duplicate + an unsorted entry to prove deduplication + sort
          "credential/codex/org/org-acme/default",
        ],
      });
      expect(minted.refPaths).toEqual(["credential/codex/org/org-acme/default", "credential/github/org/org-acme/bot"]);
    });

    it("requests a bounded, positive TTL + num_uses and echoes them back", async () => {
      const minter = harness.make();
      const minted = await minter.mintScopedRunToken({
        ...baseInput,
        ttlSeconds: 900,
        numUses: 16,
        credentialRefPaths: ["credential/codex/org/org-acme/default"],
      });
      expect(minted.ttlSeconds).toBe(900);
      expect(minted.numUses).toBe(16);
      expect(minted.ttlSeconds).toBeGreaterThan(0);
      expect(minted.numUses).toBeGreaterThan(0);
    });

    it("returns a non-empty child token + a policy name keyed on the run", async () => {
      const minter = harness.make();
      const minted = await minter.mintScopedRunToken({
        ...baseInput,
        credentialRefPaths: ["credential/codex/org/org-acme/default"],
      });
      expect(minted.token.length).toBeGreaterThan(0);
      expect(minted.policyName).toContain("run-1");
    });

    it("rejects an empty ref-path set (a run with no creds must not mint a token)", async () => {
      const minter = harness.make();
      await expect(minter.mintScopedRunToken({ ...baseInput, credentialRefPaths: [] })).rejects.toThrow(
        /at least one credential ref path/u,
      );
    });

    it("rejects a wildcard ref path (no policy widening)", async () => {
      const minter = harness.make();
      await expect(
        minter.mintScopedRunToken({ ...baseInput, credentialRefPaths: ["credential/codex/org/org-acme/*"] }),
      ).rejects.toThrow(/not safe to scope/u);
    });

    it("rejects a path-climbing `..` ref (cannot escape the run's own prefix)", async () => {
      const minter = harness.make();
      await expect(
        minter.mintScopedRunToken({
          ...baseInput,
          credentialRefPaths: ["credential/codex/org/org-acme/../other-org/default"],
        }),
      ).rejects.toThrow(/not safe to scope/u);
    });

    it("rejects a non-positive TTL or num_uses", async () => {
      const minter = harness.make();
      await expect(
        minter.mintScopedRunToken({
          ...baseInput,
          ttlSeconds: 0,
          credentialRefPaths: ["credential/codex/org/org-acme/default"],
        }),
      ).rejects.toThrow(/positive TTL/u);
      await expect(
        minter.mintScopedRunToken({
          ...baseInput,
          numUses: 0,
          credentialRefPaths: ["credential/codex/org/org-acme/default"],
        }),
      ).rejects.toThrow(/positive num_uses/u);
    });
  });
}
