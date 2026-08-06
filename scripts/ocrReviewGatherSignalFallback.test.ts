import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..");
const workflowPath = join(repoRoot, ".github/workflows/ocr-review-untrusted.yml");
const workflow = readFileSync(workflowPath, "utf8");

function gatherStepRun(): string {
  const step = "      - name: Gather human signal\n";
  const stepStart = workflow.indexOf(step);
  expect(stepStart).toBeGreaterThanOrEqual(0);

  const runMarker = "        run: |\n";
  const runStart = workflow.indexOf(runMarker, stepStart);
  expect(runStart).toBeGreaterThan(stepStart);

  const body = [];
  const bodyStart = runStart + runMarker.length;
  for (const line of workflow.slice(bodyStart).split("\n")) {
    if (line !== "" && !line.startsWith("          ")) break;
    body.push(line === "" ? "" : line.slice(10));
  }

  return body
    .join("\n")
    .replaceAll("${{ steps.base.outputs.scripts }}", "$TRUSTED_SCRIPTS")
    .replaceAll("${{ steps.guard.outputs.rule_change }}", "$RULE_CHANGE")
    .replaceAll("${{ env.PR_NUMBER }}", "$PR_NUMBER");
}

function runGatherStep({
  trustedScript,
  ruleChange,
  checkedOutScript,
}: {
  trustedScript: boolean;
  ruleChange: boolean;
  checkedOutScript: boolean;
}) {
  const root = mkdtempSync(join(tmpdir(), "tanren-ocr-signal-"));
  const trustedScripts = join(root, "trusted-scripts");
  const checkedOutRoot = join(root, "head");
  const checkedOutScripts = join(checkedOutRoot, "ops/review/scripts");
  const bin = join(root, "bin");
  const callLog = join(root, "node-call");
  mkdirSync(trustedScripts, { recursive: true });
  mkdirSync(checkedOutScripts, { recursive: true });
  mkdirSync(bin, { recursive: true });

  if (trustedScript) writeFileSync(join(trustedScripts, "gather-signal.mjs"), "trusted\n");
  if (checkedOutScript) writeFileSync(join(checkedOutScripts, "gather-signal.mjs"), "checked-out\n");

  const fakeNode = join(bin, "node");
  writeFileSync(fakeNode, '#!/bin/sh\nprintf "%s\\n" "$*" > "$NODE_CALL_LOG"\n');
  chmodSync(fakeNode, 0o755);

  const result = spawnSync("bash", ["-euo", "pipefail", "-c", gatherStepRun()], {
    cwd: checkedOutRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      TRUSTED_SCRIPTS: trustedScripts,
      RULE_CHANGE: String(ruleChange),
      PR_NUMBER: "1314",
      NODE_CALL_LOG: callLog,
      RUNNER_TEMP: root,
    },
  });

  const nodeCall = (() => {
    try {
      return readFileSync(callLog, "utf8");
    } catch {
      return null;
    }
  })();
  rmSync(root, { recursive: true, force: true });
  return { result, nodeCall };
}

describe("OCR gather-signal compatibility fallback", () => {
  it("runs the checked-out copy only after a trusted rule-change guard", () => {
    const guardStart = workflow.indexOf("      - name: Guard reviewer-config changes\n");
    const gatherStart = workflow.indexOf("      - name: Gather human signal\n");
    expect(guardStart).toBeGreaterThanOrEqual(0);
    expect(gatherStart).toBeGreaterThan(guardStart);

    const run = runGatherStep({ trustedScript: false, ruleChange: true, checkedOutScript: true });
    expect(run.result.status).toBe(0);
    expect(run.nodeCall).toContain("ops/review/scripts/gather-signal.mjs --pr 1314");
    expect(run.result.stdout).toContain("using checked-out copy after rule-change guard");
  });

  it("fails closed without invoking a checked-out copy when rule_change is false", () => {
    const run = runGatherStep({ trustedScript: false, ruleChange: false, checkedOutScript: true });
    expect(run.result.status).not.toBe(0);
    expect(run.result.stdout).toContain("gather-signal.mjs unavailable; refusing to authorize review");
    expect(run.nodeCall).toBeNull();
  });

  it("keeps the existing trusted path for an unchanged reviewer", () => {
    const run = runGatherStep({ trustedScript: true, ruleChange: false, checkedOutScript: true });
    expect(run.result.status).toBe(0);
    expect(run.nodeCall).toContain("trusted-scripts/gather-signal.mjs --pr 1314");
    expect(run.nodeCall).not.toContain("ops/review/scripts/gather-signal.mjs");
  });
});
