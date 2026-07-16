// gv-3 dashboard proof: PolicyIdentityPanel renders the receipt and actionable errors.
// Named proof: `gv3_policy_identity_receipt`.

import { describe, expect, it } from "vitest";
import { jsx } from "hono/jsx";
import { renderToString } from "hono/jsx/dom/server";
import { PolicyIdentityPanel } from "../src/components/config/PolicyIdentityPanel.js";
import { ConfigView } from "../src/components/config/ConfigView.js";
import { isPolicyIdentityView } from "../src/api/policyIdentity.js";

const okView = {
  orgId: "org_1",
  projectId: "proj_1",
  policyHash: "a".repeat(64),
  fields: ["auditPosture", "reviewPolicy"],
  schemaVersion: 1 as const,
  proof: "gv3_policy_identity_receipt" as const,
};

describe("policy identity UI (gv-3)", () => {
  it("renders the hash receipt when the read succeeds", () => {
    const html = renderToString(
      jsx(PolicyIdentityPanel, {
        projectId: "proj_1",
        projectName: "demo",
        result: { ok: true, view: okView },
      }),
    );
    expect(html).toContain('data-proof="gv3_policy_identity_receipt"');
    expect(html).toContain("a".repeat(64));
    expect(html).toContain("auditPosture");
  });

  it("surfaces denial and malformed failures actionably (negative)", () => {
    const denied = renderToString(
      jsx(PolicyIdentityPanel, {
        projectId: "proj_1",
        projectName: "demo",
        result: { ok: false, reason: "denied" },
      }),
    );
    expect(denied).toContain("Access denied");

    const malformed = renderToString(
      jsx(PolicyIdentityPanel, {
        projectId: "proj_1",
        projectName: "demo",
        result: { ok: false, reason: "malformed" },
      }),
    );
    expect(malformed).toContain("failed validation");
  });

  it("ConfigView embeds the panel", () => {
    const html = renderToString(
      jsx(ConfigView, {
        orgId: "org_1",
        orgLogin: "acme",
        gateEnabled: false,
        configFile: "tanren.yaml",
        diff: [],
        checks: [],
        impact: [],
        history: [],
        policyProjectId: "proj_1",
        policyProjectName: "demo",
        policyIdentity: {
          ok: true,
          view: { ...okView, policyHash: "b".repeat(64), fields: ["auditPosture"] },
        },
      }),
    );
    expect(html).toContain("policy identity");
    expect(html).toContain("b".repeat(64));
  });

  it("isPolicyIdentityView rejects blank / schema-literal hashes", () => {
    expect(
      isPolicyIdentityView({
        orgId: "o",
        projectId: "p",
        policyHash: "1",
        fields: ["auditPosture"],
        schemaVersion: 1,
        proof: "gv3_policy_identity_receipt",
      }),
    ).toBe(false);
    expect(
      isPolicyIdentityView({
        orgId: "o",
        projectId: "p",
        policyHash: "c".repeat(64),
        fields: ["auditPosture"],
        schemaVersion: 1,
        proof: "gv3_policy_identity_receipt",
      }),
    ).toBe(true);
  });
});
