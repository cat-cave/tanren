// ds-8 external bridge contract controls: invalid/secret-bearing input is rejected
// before a receipt can exist, and the only receipt dispositions are non-success.

import { describe, expect, it } from "vitest";
import {
  DesignEcosystemCommandSchema,
  ExternalDesignImportReceiptV1Schema,
} from "../src/engine/design/system/designEcosystemContracts.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

describe("figma/registry bridge conformance", () => {
  it("accepts the frozen, credential-free receipt shape only", () => {
    const parsed = ExternalDesignImportReceiptV1Schema.safeParse({
      version: 1,
      schemaVersion: "design_external_import.v1",
      source: "figma",
      locator: "figma://file/abc",
      externalRevision: "v7",
      snapshotDigest: DIGEST,
      licenseVerdict: "approved",
      lossinessReport: { lossless: true, warnings: [] },
      disposition: "quarantined",
    });
    expect(parsed.success).toBe(true);
    expect(ExternalDesignImportReceiptV1Schema.safeParse({ ...parsed.data, bearerToken: "must-not-fit" }).success).toBe(
      false,
    );
  });

  it("rejects unknown providers and malformed/lossy command bodies at the gate", () => {
    expect(
      DesignEcosystemCommandSchema.safeParse({
        type: "import_registry",
        externalImportId: "external_a",
        locator: "registry://pkg/a",
        externalRevision: "1",
        snapshotDigest: DIGEST,
        licenseVerdict: "approved",
        lossinessReport: { lossless: false, warnings: ["token dropped"] },
        provider: "unknown",
      }).success,
    ).toBe(false);
    expect(
      DesignEcosystemCommandSchema.safeParse({
        type: "pull_figma",
        externalImportId: "external_a",
        locator: " ",
        externalRevision: "1",
        snapshotDigest: DIGEST,
        licenseVerdict: "approved",
        lossinessReport: { lossless: false, warnings: [] },
      }).success,
    ).toBe(false);
  });
});
