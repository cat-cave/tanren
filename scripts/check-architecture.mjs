import { existsSync } from "node:fs";
import { glob, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { exit } from "node:process";
import { runStructureChecks } from "./check-architecture-structure.mjs";
import {
  checkDockerApiAllocatorOnly,
  checkNoDockerExec,
  checkNoHostBindMounts,
  checkNoHostProcessSpawn,
} from "./check-architecture-substrate.mjs";

const patterns = [
  "**/*.{ts,tsx,js,mjs,json,md,yml,yaml,sql,sh}",
  ".github/**/*.{yml,yaml}",
  "Dockerfile",
  "**/Dockerfile",
  "justfile",
];
const ignoredDirs = new Set(["node_modules", "dist", "coverage", ".git"]);
// PROJECT_BRIEF + R-WAVES are long-running narrative/checklist docs (R-WAVES
// gains a section each wave); the 500-line code cap does not fit them.
const lineMaxExclusions = new Set(["PROJECT_BRIEF.md", "pnpm-lock.yaml", "docs/roadmap/R-WAVES.md"]);
const invariantDocExclusions = new Set(["PROJECT_BRIEF.md", "docs/contracts/architecture-checks.md"]);
// Plane-split P3b: these files deliberately attempt (or document) a RAW event
// insert by the de-privileged data-plane role to PROVE Postgres REJECTS it — not
// a production write path, so they are exempt from the single-event-writer rule.
const singleEventWriterExclusions = new Set([
  "services/orchestrator/tests/planeSplitP3bDeprivilege.integration.test.ts",
  "scripts/smoke/plane-split-deprivilege.ts",
  "scripts/smoke/plane-split-worker.ts",
  "docs/roadmap/R-WAVES.md",
  "justfile",
]);
const requiredDocs = [
  "AGENTS.md",
  "docs/playbooks/spec-template.md",
  "docs/playbooks/version-verification.md",
  "docs/playbooks/github-workflow.md",
  "docs/contracts/architecture-checks.md",
];
const costBases = new Set(["ccusage", "provider_pricing", "unknown"]);
const billingModes = new Set(["per_token", "subscription", "self_hosted"]);

function normalizePath(path) {
  return path.split("\\").join("/");
}

function isIgnored(path) {
  return normalizePath(path)
    .split("/")
    .some((part) => ignoredDirs.has(part));
}

function lineFor(text, index) {
  return text.slice(0, index).split("\n").length;
}

function diagnostic(rule, file, message, line = 1) {
  return { rule, file, line, message };
}

async function collectFiles(root) {
  const files = new Set();
  for (const pattern of patterns) {
    for await (const entry of glob(pattern, { cwd: root })) {
      const file = normalizePath(entry);
      if (!isIgnored(file)) {
        files.add(file);
      }
    }
  }
  return [...files].toSorted();
}

async function readProjectFiles(root) {
  const files = await collectFiles(root);
  const projectFiles = [];
  for (const file of files) {
    projectFiles.push({ file, text: await readFile(resolve(root, file), "utf8") });
  }
  return projectFiles;
}

function checkRequiredDocs(root) {
  return requiredDocs
    .filter((file) => !existsSync(resolve(root, file)))
    .map((file) => diagnostic("required-docs-present", file, "required architecture document is missing"));
}

function checkLineMax(projectFiles) {
  const diagnostics = [];
  for (const { file, text } of projectFiles) {
    if (
      lineMaxExclusions.has(file) ||
      file.startsWith("db/migrations/meta/") ||
      file.startsWith("services/orchestrator/src/engine/answerers/schemas/generated/") ||
      file.startsWith("contracts/json/")
    ) {
      continue;
    }
    const lineCount = text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
    if (lineCount > 500) {
      diagnostics.push(diagnostic("file-line-max-500", file, `${lineCount} lines exceeds the 500-line cap`));
    }
  }
  return diagnostics;
}

function checkSingleEventWriter(projectFiles) {
  const diagnostics = [];
  const sqlInsert = new RegExp("INSERT\\s+INTO\\s+events", "giu");
  const drizzleInsert = /db\.insert\s*\(\s*events\s*\)/gu;
  for (const { file, text } of projectFiles) {
    if (
      invariantDocExclusions.has(file) ||
      singleEventWriterExclusions.has(file) ||
      file === "services/orchestrator/src/engine/eventStore.ts" ||
      file.startsWith("db/migrations/")
    ) {
      continue;
    }
    for (const pattern of [sqlInsert, drizzleInsert]) {
      for (const match of text.matchAll(pattern)) {
        diagnostics.push(
          diagnostic(
            "single-event-writer",
            file,
            "events may only be written through eventStore",
            lineFor(text, match.index),
          ),
        );
      }
    }
  }
  return diagnostics;
}

function checkFailureVariants(projectFiles) {
  const diagnostics = [];
  const failurePatterns = [/kind\s*:\s*["']host_[^"']+["']/gu, /\|\s*["']host_[^"']+["']/gu];
  for (const { file, text } of projectFiles) {
    if (invariantDocExclusions.has(file)) {
      continue;
    }
    for (const pattern of failurePatterns) {
      for (const match of text.matchAll(pattern)) {
        diagnostics.push(
          diagnostic(
            "forbidden-failure-variants",
            file,
            "host-prefixed failure variants are forbidden",
            lineFor(text, match.index),
          ),
        );
      }
    }
  }
  return diagnostics;
}

function isRoleDispatcher(file) {
  return (
    file.startsWith("services/orchestrator/src/engine/workflow/") ||
    file.startsWith("services/orchestrator/src/engine/dispatchers/")
  );
}

function checkWriterAnswererSeparation(projectFiles) {
  const diagnostics = [];
  for (const { file, text } of projectFiles) {
    if (!file.startsWith("services/orchestrator/src/") || file.includes("/providers/") || isRoleDispatcher(file)) {
      continue;
    }
    if (text.includes("runWriter") && text.includes("runAnswerer")) {
      diagnostics.push(
        diagnostic(
          "writer-answerer-separation",
          file,
          "non-dispatcher code may not mix writer and answerer execution paths",
        ),
      );
    }
  }
  return diagnostics;
}

function checkCostSources(projectFiles) {
  const diagnostics = [];
  const legacy = new RegExp(`${"legacy"}_${"unknown"}`, "gu");
  // Each column's SQL CHECK must exactly match its accepted value set.
  const enumChecks = [
    {
      pattern: /cost_basis\s+IN\s*\(([^)]*)\)/giu,
      allowed: costBases,
      label: "cost_basis (ccusage, provider_pricing, unknown)",
    },
    {
      pattern: /billing_mode\s+IN\s*\(([^)]*)\)/giu,
      allowed: billingModes,
      label: "billing_mode (per_token, subscription, self_hosted)",
    },
  ];
  for (const { file, text } of projectFiles) {
    if (invariantDocExclusions.has(file)) {
      continue;
    }
    for (const match of text.matchAll(legacy)) {
      diagnostics.push(
        diagnostic(
          "no-unknown-cost-source",
          file,
          "placeholder cost sources are not allowed",
          lineFor(text, match.index),
        ),
      );
    }
    for (const { pattern, allowed, label } of enumChecks) {
      for (const match of text.matchAll(pattern)) {
        const values = [...match[1].matchAll(/'([^']+)'/gu)].map((value) => value[1]);
        if (values.some((value) => !allowed.has(value)) || values.length !== allowed.size) {
          diagnostics.push(
            diagnostic(
              "no-unknown-cost-source",
              file,
              `${label} checks must exactly match the accepted values`,
              lineFor(text, match.index),
            ),
          );
        }
      }
    }
  }
  return diagnostics;
}

function checkGitHubActions(projectFiles) {
  const diagnostics = [];
  for (const { file, text } of projectFiles) {
    if (!file.startsWith(".github/workflows/")) {
      continue;
    }
    for (const action of ["actions/checkout", "actions/setup-node"]) {
      const pattern = new RegExp(`${action}@v(\\d+)`, "gu");
      for (const match of text.matchAll(pattern)) {
        if (match[1] !== "6") {
          diagnostics.push(
            diagnostic(
              "github-actions-current-major",
              file,
              `${action} must use verified major v6`,
              lineFor(text, match.index),
            ),
          );
        }
      }
    }
  }
  return diagnostics;
}

// Files that still contain pre-Phase-2A raw row casts. New casts in workflow
// code are rejected; clearing this allowlist as those files migrate is part
// of the typed-state contract owned by P2A-0005.
const workflowRowCastAllowlist = new Set([
  "services/orchestrator/src/engine/workflow/ciPolling.ts",
  "services/orchestrator/src/engine/workflow/githubDraftPr.ts",
]);

function checkNoRowCastsInWorkflow(projectFiles) {
  const diagnostics = [];
  // Detect `... as Something` where the cast immediately follows .rows[N] or
  // a variable named `row`/`rows`. Allow `as const` casts (they're not row
  // shape casts) and exempt the explicit allowlist above.
  const rowCastPatterns = [/\.rows\[[^\]]*\]\s+as\s+(?!const\b)[A-Za-z_$]/gu, /\brow\s+as\s+(?!const\b)[A-Za-z_$]/gu];
  for (const { file, text } of projectFiles) {
    if (!file.startsWith("services/orchestrator/src/engine/workflow/")) {
      continue;
    }
    if (workflowRowCastAllowlist.has(file)) {
      continue;
    }
    for (const pattern of rowCastPatterns) {
      for (const match of text.matchAll(pattern)) {
        diagnostics.push(
          diagnostic(
            "no-raw-row-casts-in-workflow",
            file,
            "workflow code must decode rows through typed repositories (see services/orchestrator/src/engine/repositories)",
            lineFor(text, match.index),
          ),
        );
      }
    }
  }
  return diagnostics;
}

function checkStateDriftWiring(projectFiles) {
  const packageFile = projectFiles.find((item) => item.file === "package.json");
  const justfile = projectFiles.find((item) => item.file === "justfile");
  const hasGeneratorScript = projectFiles.some((item) => item.file === "scripts/generate-state-checks.mjs");
  if (!hasGeneratorScript) {
    return [
      diagnostic("state-drift-check-wired", "scripts/generate-state-checks.mjs", "state drift generator is missing"),
    ];
  }
  if (!packageFile) {
    return [
      diagnostic("state-drift-check-wired", "package.json", "root package.json is required for state drift wiring"),
    ];
  }
  try {
    const pkg = JSON.parse(packageFile.text);
    const scripts = pkg.scripts ?? {};
    const checkScript = String(scripts.check ?? "");
    const stateScript = String(scripts["check:state-drift"] ?? "");
    if (!stateScript.includes("scripts/generate-state-checks.mjs")) {
      return [
        diagnostic(
          "state-drift-check-wired",
          "package.json",
          "check:state-drift must run scripts/generate-state-checks.mjs",
        ),
      ];
    }
    const rootCheckRunsStateDrift =
      checkScript.includes("check:state-drift") ||
      (checkScript.includes("just ci") && justfile?.text.includes("ci:") && justfile.text.includes("state-drift"));
    if (!rootCheckRunsStateDrift) {
      return [
        diagnostic(
          "state-drift-check-wired",
          "package.json",
          "root check must include check:state-drift or delegate to just ci",
        ),
      ];
    }
  } catch {
    return [diagnostic("state-drift-check-wired", "package.json", "root package.json must be valid JSON")];
  }
  return [];
}

function checkAnswererSchemaDriftWiring(projectFiles) {
  const rule = "answerer-schema-drift-check-wired";
  const pkg = projectFiles.find((item) => item.file === "package.json");
  const just = projectFiles.find((item) => item.file === "justfile");
  if (!projectFiles.some((item) => item.file === "scripts/answerer-schema-export.mjs")) {
    return [diagnostic(rule, "scripts/answerer-schema-export.mjs", "answerer schema codegen script is missing")];
  }
  if (!pkg) {
    return [diagnostic(rule, "package.json", "root package.json is required for answerer schema drift wiring")];
  }
  try {
    const json = JSON.parse(pkg.text);
    const scripts = json.scripts ?? {};
    const drift = String(scripts["check:answerer-schema-drift"] ?? "");
    const check = String(scripts.check ?? "");
    if (!drift.includes("scripts/answerer-schema-export.mjs")) {
      return [
        diagnostic(rule, "package.json", "check:answerer-schema-drift must run scripts/answerer-schema-export.mjs"),
      ];
    }
    const wired =
      check.includes("check:answerer-schema-drift") ||
      (check.includes("just ci") && just?.text.includes("ci:") && just.text.includes("answerer-schema-drift"));
    if (!wired) {
      return [
        diagnostic(rule, "package.json", "root check must include check:answerer-schema-drift or delegate to just ci"),
      ];
    }
  } catch {
    return [diagnostic(rule, "package.json", "root package.json must be valid JSON")];
  }
  return [];
}

function checkContractSchemaDriftWiring(projectFiles) {
  const rule = "contract-schema-drift-check-wired";
  const pkg = projectFiles.find((item) => item.file === "package.json");
  const just = projectFiles.find((item) => item.file === "justfile");
  if (!projectFiles.some((item) => item.file === "scripts/contract-schema-export.mjs")) {
    return [diagnostic(rule, "scripts/contract-schema-export.mjs", "contract schema codegen script is missing")];
  }
  if (!pkg) {
    return [diagnostic(rule, "package.json", "root package.json is required for contract schema drift wiring")];
  }
  try {
    const json = JSON.parse(pkg.text);
    const scripts = json.scripts ?? {};
    const drift = String(scripts["check:contract-schema-drift"] ?? "");
    const check = String(scripts.check ?? "");
    if (!drift.includes("scripts/contract-schema-export.mjs")) {
      return [
        diagnostic(rule, "package.json", "check:contract-schema-drift must run scripts/contract-schema-export.mjs"),
      ];
    }
    const wired =
      check.includes("check:contract-schema-drift") ||
      (check.includes("just ci") && just?.text.includes("ci:") && just.text.includes("contract-schema-drift"));
    if (!wired) {
      return [
        diagnostic(rule, "package.json", "root check must include check:contract-schema-drift or delegate to just ci"),
      ];
    }
  } catch {
    return [diagnostic(rule, "package.json", "root package.json must be valid JSON")];
  }
  return [];
}

function checkSchemaDriftWiring(projectFiles) {
  const packageFile = projectFiles.find((item) => item.file === "package.json");
  const justfile = projectFiles.find((item) => item.file === "justfile");
  const hasDriftScript = projectFiles.some((item) => item.file === "scripts/check-schema-drift.sh");
  if (!hasDriftScript) {
    return [
      diagnostic("schema-drift-check-wired", "scripts/check-schema-drift.sh", "schema drift check script is missing"),
    ];
  }

  if (!packageFile) {
    return [
      diagnostic("schema-drift-check-wired", "package.json", "root package.json is required for schema drift wiring"),
    ];
  }

  try {
    const pkg = JSON.parse(packageFile.text);
    const scripts = pkg.scripts ?? {};
    const checkScript = String(scripts.check ?? "");
    const driftScript = String(scripts["check:schema-drift"] ?? "");

    if (!driftScript.includes("scripts/check-schema-drift.sh")) {
      return [
        diagnostic(
          "schema-drift-check-wired",
          "package.json",
          "check:schema-drift must run scripts/check-schema-drift.sh",
        ),
      ];
    }
    const rootCheckRunsSchemaDrift =
      checkScript.includes("check:schema-drift") ||
      (checkScript.includes("just ci") && justfile?.text.includes("ci:") && justfile.text.includes("schema-drift"));
    if (!rootCheckRunsSchemaDrift) {
      return [
        diagnostic(
          "schema-drift-check-wired",
          "package.json",
          "root check must include check:schema-drift or delegate to just ci",
        ),
      ];
    }
  } catch {
    return [diagnostic("schema-drift-check-wired", "package.json", "root package.json must be valid JSON")];
  }

  return [];
}

export async function runArchitectureChecks({ root = process.cwd() } = {}) {
  const resolvedRoot = resolve(root);
  const projectFiles = await readProjectFiles(resolvedRoot);
  return [
    ...checkRequiredDocs(resolvedRoot),
    ...checkLineMax(projectFiles),
    ...checkNoHostProcessSpawn(projectFiles),
    ...checkNoDockerExec(projectFiles),
    ...checkNoHostBindMounts(projectFiles),
    ...checkDockerApiAllocatorOnly(projectFiles),
    ...checkSingleEventWriter(projectFiles),
    ...checkFailureVariants(projectFiles),
    ...checkWriterAnswererSeparation(projectFiles),
    ...checkCostSources(projectFiles),
    ...checkGitHubActions(projectFiles),
    ...checkSchemaDriftWiring(projectFiles),
    ...checkStateDriftWiring(projectFiles),
    ...checkAnswererSchemaDriftWiring(projectFiles),
    ...checkContractSchemaDriftWiring(projectFiles),
    ...checkNoRowCastsInWorkflow(projectFiles),
    ...runStructureChecks(projectFiles),
  ];
}

export function formatDiagnostics(diagnostics, root = process.cwd()) {
  return diagnostics
    .map((item) => `${relative(root, resolve(root, item.file))}:${item.line}: ${item.rule}: ${item.message}`)
    .join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const diagnostics = await runArchitectureChecks();
  if (diagnostics.length > 0) {
    console.error(formatDiagnostics(diagnostics));
    exit(1);
  }
  console.log("architecture checks passed");
}
