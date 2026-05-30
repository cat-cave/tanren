// P3-0017 tanren-config audit-gate unit tests (pure module). Covers Bucket-B
// detection, the tanren.yaml render + diff, the gated-write decision (gate ON
// opens a PR via a fake GitHub port instead of applying; gate OFF / non-Bucket-B
// applies directly), and apply-on-merge.

import { describe, expect, it, vi } from "vitest";
import { migrateOrgConfig, type OrgConfigV1 } from "../src/engine/config/orgConfig.js";
import {
  applyOnMerge,
  gatedConfigWrite,
  isBucketBChange,
  renderTanrenYaml,
  renderTanrenYamlDiff,
  type ConfigGateGitHub,
} from "../src/engine/config/tanrenConfigGate.js";

function baseConfig(): OrgConfigV1 {
  return migrateOrgConfig({
    version: 1,
    routing: {
      audit: { chain: [{ cli: "codex", model: "gpt-5.5", authRef: "credential/openai" }] },
    },
  });
}

function withAuditPrimary(model: string): OrgConfigV1 {
  return migrateOrgConfig({
    version: 1,
    auditGateEnabled: true,
    auditGate: { repo: "cat-cave/tanren-config" },
    routing: {
      audit: { chain: [{ cli: "claude", model, authRef: "credential/claude" }] },
    },
  });
}

const TARGET = {
  repo: "cat-cave/tanren-config",
  baseBranch: "main",
  branchPrefix: "forge",
  configFile: "tanren.yaml",
};

describe("isBucketBChange", () => {
  it("is true when a routing chain changes", () => {
    expect(isBucketBChange(baseConfig(), withAuditPrimary("opus-4.7"))).toBe(true);
  });

  it("is true when an escape-hatch limit changes", () => {
    const next = migrateOrgConfig({ version: 1, escapeHatches: { maxWriterIterPerSubtask: 8 } });
    expect(isBucketBChange(baseConfig(), next)).toBe(true);
  });

  it("is false when only the gate toggle / target changes (so you can turn it off)", () => {
    const prev = baseConfig();
    const next = migrateOrgConfig({ ...prev, auditGateEnabled: true, auditGate: { repo: "x/y" } });
    expect(isBucketBChange(prev, next)).toBe(false);
  });
});

describe("renderTanrenYaml + diff", () => {
  it("renders routing + limits as tanren.yaml", () => {
    const yaml = renderTanrenYaml(baseConfig());
    expect(yaml).toContain("# tanren.yaml");
    expect(yaml).toContain('audit.primary = "codex/gpt-5.5"');
    expect(yaml).toContain("max_writer_iter = 5");
  });

  it("renders a changed value as rem-then-add", () => {
    const diff = renderTanrenYamlDiff(baseConfig(), withAuditPrimary("opus-4.7"));
    const rem = diff.find((l) => l.t === "rem");
    const add = diff.find((l) => l.t === "add");
    expect(rem?.s).toContain("codex/gpt-5.5");
    expect(add?.s).toContain("claude/opus-4.7");
  });
});

describe("gatedConfigWrite", () => {
  it("gate ON + Bucket-B write → opens a PR instead of applying", async () => {
    const openConfigPr = vi.fn<ConfigGateGitHub["openConfigPr"]>(async () => ({
      number: 7,
      url: "https://github.com/cat-cave/tanren-config/pull/7",
      branch: "forge/route-x",
    }));
    const github: ConfigGateGitHub = { openConfigPr };
    const result = await gatedConfigWrite({
      prev: baseConfig(),
      next: withAuditPrimary("opus-4.7"),
      target: TARGET,
      github,
    });
    expect(result.kind).toBe("gated");
    if (result.kind !== "gated") throw new Error("expected gated");
    expect(result.pr.number).toBe(7);
    expect(result.diff.some((l) => l.t === "add")).toBe(true);
    // The PR carried the new YAML, not the old one.
    expect(openConfigPr).toHaveBeenCalledOnce();
    const call = openConfigPr.mock.calls[0][0];
    expect(call.yaml).toContain("claude/opus-4.7");
    expect(call.configFile).toBe("tanren.yaml");
    expect(call.repo).toBe("cat-cave/tanren-config");
  });

  it("gate OFF → applies directly (no PR)", async () => {
    const openConfigPr = vi.fn<ConfigGateGitHub["openConfigPr"]>();
    const next = baseConfig();
    next.routing.audit.chain = [{ cli: "claude", model: "opus-4.7", authRef: "credential/claude" }];
    const result = await gatedConfigWrite({
      prev: baseConfig(),
      next,
      target: TARGET,
      github: { openConfigPr },
    });
    expect(result.kind).toBe("apply-directly");
    expect(openConfigPr).not.toHaveBeenCalled();
  });

  it("gate ON but non-Bucket-B change (toggle only) → applies directly", async () => {
    const openConfigPr = vi.fn<ConfigGateGitHub["openConfigPr"]>();
    const prev = baseConfig();
    const next = migrateOrgConfig({ ...prev, auditGateEnabled: true, auditGate: { repo: "x/y" } });
    const result = await gatedConfigWrite({ prev, next, target: TARGET, github: { openConfigPr } });
    expect(result.kind).toBe("apply-directly");
    expect(openConfigPr).not.toHaveBeenCalled();
  });

  it("gate ON + Bucket-B but no client → throws (never silently applies)", async () => {
    await expect(
      gatedConfigWrite({ prev: baseConfig(), next: withAuditPrimary("opus-4.7"), target: TARGET }),
    ).rejects.toThrow(/no tanren-config/u);
  });
});

describe("applyOnMerge", () => {
  it("persists the merged config when the gate is ON", async () => {
    const persist = vi.fn<(c: OrgConfigV1) => Promise<void>>(async () => {});
    const applied = await applyOnMerge({
      current: withAuditPrimary("opus-4.7"),
      merged: withAuditPrimary("opus-4.7"),
      persist,
    });
    expect(applied).toBe(true);
    expect(persist).toHaveBeenCalledOnce();
  });

  it("is a no-op when the gate is OFF (a stray merge never rewrites config)", async () => {
    const persist = vi.fn<(c: OrgConfigV1) => Promise<void>>(async () => {});
    const applied = await applyOnMerge({
      current: baseConfig(),
      merged: withAuditPrimary("opus-4.7"),
      persist,
    });
    expect(applied).toBe(false);
    expect(persist).not.toHaveBeenCalled();
  });
});
