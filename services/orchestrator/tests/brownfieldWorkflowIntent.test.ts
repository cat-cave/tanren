// Brownfield workflow-INTENT classifier + migration-risk report tests.
//
// Exercises the PURE classifier over representative recon-index fixtures (a CI
// workflow running lint+test+build → quick/spec/task gates; a deploy workflow →
// deploy_plan; a scheduled cron → scheduled_operation; a marketplace SAST action
// → external_check) and the report-builder's load-bearing not-ready rule. No
// network, no provider, no pool — the classifier consumes the already-fetched
// index.

import { describe, expect, it } from "vitest";
import {
  buildMigrationReport,
  classifyWorkflowIntents,
  type WorkflowIntent,
} from "../src/engine/forge/brownfield/index.js";
import type { ReconIndex } from "../src/engine/forge/brownfield/types.js";

function indexOf(files: { path: string; preview: string }[]): ReconIndex {
  return {
    repoUrl: "https://github.com/acme/widget",
    filesIndexed: files.length,
    files: files.map((f) => ({ path: f.path, size: f.preview.length, preview: f.preview })),
  };
}

function byCategory(intents: WorkflowIntent[], category: WorkflowIntent["category"]): WorkflowIntent | undefined {
  return intents.find((i) => i.category === category);
}

const CI_WORKFLOW = `
name: ci
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm run lint
      - run: pnpm exec tsc --noEmit
      - run: pnpm run test
      - run: pnpm run build
`;

const DEPLOY_WORKFLOW = `
name: deploy
on:
  push:
    branches: [main]
jobs:
  ship:
    environment: production
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: fly deploy --app widget-prod
`;

const SCHEDULED_WORKFLOW = `
name: nightly
on:
  schedule:
    - cron: "0 2 * * *"
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm audit --audit-level high
`;

const SAST_WORKFLOW = `
name: codeql
on: [push]
jobs:
  analyze:
    runs-on: ubuntu-latest
    steps:
      - uses: github/codeql-action/analyze@v3
`;

describe("classifyWorkflowIntents · CI ladder workflow", () => {
  it("maps lint+typecheck → quick_gate, test → spec_gate, build → task_gate", () => {
    const intents = classifyWorkflowIntents({
      index: indexOf([{ path: ".github/workflows/ci.yml", preview: CI_WORKFLOW }]),
    });
    expect(byCategory(intents, "lint")?.replacement).toBe("quick_gate");
    expect(byCategory(intents, "typecheck")?.replacement).toBe("quick_gate");
    expect(byCategory(intents, "unit_test")?.replacement).toBe("spec_gate");
    expect(byCategory(intents, "build")?.replacement).toBe("task_gate");
    // All quality severity ⇒ none load-bearing.
    expect(intents.every((i) => i.severity === "quality")).toBe(true);
  });
});

describe("classifyWorkflowIntents · deploy workflow", () => {
  it("classifies a deploy step → prod_deploy → deploy_plan and the environment gate → manual_approval", () => {
    const intents = classifyWorkflowIntents({
      index: indexOf([{ path: ".github/workflows/deploy.yml", preview: DEPLOY_WORKFLOW }]),
    });
    const deploy = byCategory(intents, "prod_deploy");
    expect(deploy?.replacement).toBe("deploy_plan");
    expect(deploy?.severity).toBe("production");
    const approval = byCategory(intents, "manual_approval");
    expect(approval?.replacement).toBe("manual_gate");
    expect(approval?.severity).toBe("compliance");
  });
});

describe("classifyWorkflowIntents · scheduled cron", () => {
  it("classifies on.schedule.cron → scheduled → scheduled_operation", () => {
    const intents = classifyWorkflowIntents({
      index: indexOf([{ path: ".github/workflows/nightly.yml", preview: SCHEDULED_WORKFLOW }]),
    });
    const scheduled = byCategory(intents, "scheduled");
    expect(scheduled?.replacement).toBe("scheduled_operation");
    expect(scheduled?.name).toContain("0 2 * * *");
    // The audit step is still classified (a dependency scan).
    expect(byCategory(intents, "dependency_scan")?.replacement).toBe("external_check");
  });
});

describe("classifyWorkflowIntents · marketplace SAST action", () => {
  it("classifies a github/codeql action → sast → external_check (security)", () => {
    const intents = classifyWorkflowIntents({
      index: indexOf([{ path: ".github/workflows/codeql.yml", preview: SAST_WORKFLOW }]),
    });
    const sast = byCategory(intents, "sast");
    expect(sast?.replacement).toBe("external_check");
    expect(sast?.severity).toBe("security");
  });

  it("an unrecognized marketplace action becomes unknown → unsupported_automation", () => {
    const intents = classifyWorkflowIntents({
      index: indexOf([
        {
          path: ".github/workflows/x.yml",
          preview: "jobs:\n  j:\n    steps:\n      - uses: some-org/mystery-action@v1\n",
        },
      ]),
    });
    const unknown = byCategory(intents, "unknown");
    expect(unknown?.replacement).toBe("unsupported_automation");
    expect(unknown?.confidence).toBeLessThan(0.5);
  });
});

describe("classifyWorkflowIntents · package scripts + codeowners + branch protection", () => {
  it("classifies package.json scripts", () => {
    const pkg = JSON.stringify({ scripts: { lint: "eslint .", test: "vitest run", deploy: "fly deploy" } });
    const intents = classifyWorkflowIntents({ index: indexOf([{ path: "package.json", preview: pkg }]) });
    expect(byCategory(intents, "lint")?.source).toBe("package_script");
    expect(byCategory(intents, "unit_test")).toBeDefined();
    expect(byCategory(intents, "prod_deploy")?.replacement).toBe("deploy_plan");
  });

  // no_silent_fallbacks: a present-but-unparseable package.json must PROPAGATE
  // (loud) — silently returning [] would DROP the repo's package-script automation
  // intent from the migration-risk report (the "nothing silently dropped" guarantee).
  it("PROPAGATES on a present-but-unparseable package.json (never a silent drop)", () => {
    expect(() =>
      classifyWorkflowIntents({ index: indexOf([{ path: "package.json", preview: "{ not: valid json," }]) }),
    ).toThrow(/unparseable package\.json/u);
  });

  // An EMPTY preview is the benign "nothing indexed" state — no scripts, no throw.
  it("an empty package.json preview yields no intents (benign, not corruption)", () => {
    const intents = classifyWorkflowIntents({ index: indexOf([{ path: "package.json", preview: "" }]) });
    expect(intents.filter((i) => i.source === "package_script")).toHaveLength(0);
  });

  it("CODEOWNERS with owners → manual_approval (compliance)", () => {
    const intents = classifyWorkflowIntents({
      index: indexOf([{ path: "CODEOWNERS", preview: "# owners\n* @acme/platform\n" }]),
    });
    const review = byCategory(intents, "manual_approval");
    expect(review?.severity).toBe("compliance");
    expect(review?.replacement).toBe("manual_gate");
  });

  it("branch protection required checks + approvals classify", () => {
    const intents = classifyWorkflowIntents({
      index: indexOf([]),
      branchProtection: [
        {
          branch: "main",
          requiredStatusChecks: ["lint", "e2e"],
          requiredApprovingReviewCount: 2,
          requireCodeOwnerReviews: true,
          enforceAdmins: true,
        },
      ],
    });
    expect(byCategory(intents, "lint")?.source).toBe("branch_protection");
    expect(byCategory(intents, "e2e_test")?.replacement).toBe("merge_gate");
    expect(byCategory(intents, "manual_approval")?.severity).toBe("compliance");
  });

  it("de-dupes intents by id", () => {
    const intents = classifyWorkflowIntents({
      index: indexOf([{ path: "CODEOWNERS", preview: "* @a\n" }]),
    });
    const ids = intents.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("buildMigrationReport · not-ready-while-load-bearing-dropped rule", () => {
  const lint: WorkflowIntent = {
    id: "package_script:package.json:lint",
    source: "package_script",
    sourcePath: "package.json",
    name: "lint",
    category: "lint",
    replacement: "quick_gate",
    severity: "quality",
    confidence: 0.8,
    evidence: "lint",
  };
  const secretScan: WorkflowIntent = {
    id: "workflow:.github/workflows/sec.yml:run-gitleaks",
    source: "workflow",
    sourcePath: ".github/workflows/sec.yml",
    name: "run gitleaks",
    category: "secret_scan",
    replacement: "external_check",
    severity: "security",
    confidence: 0.9,
    evidence: "gitleaks",
  };
  const prodDeploy: WorkflowIntent = {
    id: "workflow:.github/workflows/deploy.yml:run-fly-deploy",
    source: "workflow",
    sourcePath: ".github/workflows/deploy.yml",
    name: "run fly deploy",
    category: "prod_deploy",
    replacement: "deploy_plan",
    severity: "production",
    confidence: 0.85,
    evidence: "deploy",
  };

  it("a repo whose only intents are migrated/replaced is Tanren-native-ready", () => {
    const report = buildMigrationReport({ repoUrl: "r", intents: [lint, prodDeploy] });
    // The security scan handoff is the one external-integration; with no security
    // intent present here, both carry over fine.
    expect(report.tanrenNativeReady).toBe(true);
    expect(report.blockingCount).toBe(0);
    expect(report.dispositions.find((d) => d.id === lint.id)?.status).toBe("migrated");
    expect(report.dispositions.find((d) => d.id === prodDeploy.id)?.status).toBe("replaced");
  });

  it("dropping a QUALITY intent keeps the repo ready", () => {
    const report = buildMigrationReport({ repoUrl: "r", intents: [lint], droppedIds: [lint.id] });
    expect(report.tanrenNativeReady).toBe(true);
    expect(report.dispositions[0]?.status).toBe("intentionally_dropped");
    expect(report.dispositions[0]?.blocking).toBe(false);
  });

  it("dropping a SECURITY intent flips readiness to false and marks it blocking", () => {
    const report = buildMigrationReport({ repoUrl: "r", intents: [lint, secretScan], droppedIds: [secretScan.id] });
    expect(report.tanrenNativeReady).toBe(false);
    expect(report.blockingCount).toBe(1);
    const drop = report.dispositions.find((d) => d.id === secretScan.id);
    expect(drop?.status).toBe("intentionally_dropped");
    expect(drop?.blocking).toBe(true);
  });

  it("dropping a PRODUCTION deploy intent flips readiness to false", () => {
    const report = buildMigrationReport({ repoUrl: "r", intents: [prodDeploy], droppedIds: [prodDeploy.id] });
    expect(report.tanrenNativeReady).toBe(false);
    expect(report.blockingCount).toBe(1);
  });

  it("a security scan that is NOT dropped is handed to an external integration (blocking until wired)", () => {
    const report = buildMigrationReport({ repoUrl: "r", intents: [secretScan] });
    const d = report.dispositions[0];
    expect(d?.status).toBe("requires_external_integration");
    // A load-bearing (security) external handoff is blocking until actually wired.
    expect(d?.blocking).toBe(true);
    expect(report.tanrenNativeReady).toBe(false);
  });

  it("tallies summary by status and severity", () => {
    const report = buildMigrationReport({ repoUrl: "r", intents: [lint, secretScan, prodDeploy] });
    expect(report.summary.bySeverity.quality).toBe(1);
    expect(report.summary.bySeverity.security).toBe(1);
    expect(report.summary.bySeverity.production).toBe(1);
    expect(report.summary.byStatus.migrated).toBe(1);
  });
});
