import { existsSync } from "node:fs";
import { glob, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { exit } from "node:process";

const patterns = ["**/*.{ts,tsx,js,mjs,json,md,yml,yaml,sql,sh}", ".github/**/*.{yml,yaml}", "Dockerfile", "**/Dockerfile", "justfile"];
const ignoredDirs = new Set(["node_modules", "dist", "coverage", ".git"]);
const lineMaxExclusions = new Set(["PROJECT_BRIEF.md", "pnpm-lock.yaml"]);
const invariantDocExclusions = new Set(["PROJECT_BRIEF.md", "docs/contracts/architecture-checks.md"]);
const requiredDocs = [
  "AGENTS.md",
  "docs/playbooks/spec-template.md",
  "docs/playbooks/version-verification.md",
  "docs/playbooks/github-workflow.md",
  "docs/contracts/architecture-checks.md"
];
const costSources = new Set(["provider_direct", "ccusage", "codexbar", "opportunity_computed"]);

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
    if (lineMaxExclusions.has(file) || file.startsWith("db/migrations/meta/")) {
      continue;
    }
    const lineCount = text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
    if (lineCount > 500) {
      diagnostics.push(diagnostic("file-line-max-500", file, `${lineCount} lines exceeds the 500-line cap`));
    }
  }
  return diagnostics;
}

function checkNoHostProcessSpawn(projectFiles) {
  const diagnostics = [];
  const importPattern = /(?:from\s+|import\s*\(|require\s*\()\s*["'](?:node:)?child_process["']/g;
  for (const { file, text } of projectFiles) {
    if (
      invariantDocExclusions.has(file) ||
      file.startsWith("services/orchestrator/src/engine/cli-runner/") ||
      file.startsWith("scripts/")
    ) {
      continue;
    }
    for (const match of text.matchAll(importPattern)) {
      diagnostics.push(
        diagnostic("no-host-process-spawn", file, "child_process imports are confined to cli-runner", lineFor(text, match.index))
      );
    }
  }
  return diagnostics;
}

function checkNoDockerExec(projectFiles) {
  const diagnostics = [];
  const execPatterns = [/container\.exec\s*\(/g, /\bdocker\s+exec\b/g];
  for (const { file, text } of projectFiles) {
    if (
      invariantDocExclusions.has(file) ||
      file.startsWith("services/allocator/") ||
      file.startsWith("services/orchestrator/src/engine/allocators/")
    ) {
      continue;
    }
    for (const pattern of execPatterns) {
      for (const match of text.matchAll(pattern)) {
        diagnostics.push(
          diagnostic("no-docker-exec-for-workloads", file, "workload execution must go through SSH", lineFor(text, match.index))
        );
      }
    }
  }
  return diagnostics;
}

function isHostPath(source) {
  return /^(\/|\.{1,2}\/|~\/|\$\{?(?:PWD|HOME)\}?|[A-Za-z]:[\\/])/.test(source);
}

function checkNoHostBindMounts(projectFiles) {
  const diagnostics = [];
  const apiPatterns = [/\bBinds\b\s*:/g, /\bMounts\b\s*:/g, /\btype\s*[:=]\s*["']?bind["']?/g];
  for (const { file, text } of projectFiles) {
    if (
      invariantDocExclusions.has(file) ||
      file.startsWith("services/allocator/") ||
      file.startsWith("services/orchestrator/src/engine/allocators/")
    ) {
      continue;
    }
    for (const pattern of apiPatterns) {
      for (const match of text.matchAll(pattern)) {
        diagnostics.push(diagnostic("no-host-bind-mounts", file, "host bind mounts are not allowed", lineFor(text, match.index)));
      }
    }
    text.split("\n").forEach((line, index) => {
      const match = line.match(/^\s*-\s*["']?([^"'\s:]+):\/[^"']*["']?\s*$/);
      if (match && isAllowedAllocatorDockerSocketMount(file, text, index + 1)) {
        return;
      }
      if (match && isHostPath(match[1])) {
        diagnostics.push(diagnostic("no-host-bind-mounts", file, "compose service volume uses a host path", index + 1));
      }
    });
  }
  return diagnostics;
}

function isComposeFile(file) {
  return file === "compose.yml" || file === "compose.dev.yml" || file === "compose.prod.yml";
}

function isAllowedDockerSocketMount(file, line) {
  return isComposeFile(file) && line.trim() === "- /var/run/docker.sock:/var/run/docker.sock";
}

function isAllowedAllocatorDockerSocketMount(file, text, lineNumber) {
  if (!isComposeFile(file)) {
    return false;
  }

  let currentService;
  let inVolumes = false;
  const lines = text.split("\n");
  for (let index = 0; index < lineNumber; index += 1) {
    const line = lines[index] ?? "";
    const serviceMatch = line.match(/^  ([a-zA-Z0-9_-]+):\s*$/);
    if (serviceMatch) {
      currentService = serviceMatch[1];
      inVolumes = false;
      continue;
    }
    if (line.match(/^    volumes:\s*$/)) {
      inVolumes = currentService === "allocator";
      continue;
    }
    if (line.match(/^    [a-zA-Z0-9_-]+:/)) {
      inVolumes = false;
    }
  }

  return currentService === "allocator" && inVolumes && isAllowedDockerSocketMount(file, lines[lineNumber - 1] ?? "");
}

function checkDockerApiAllocatorOnly(projectFiles) {
  const diagnostics = [];
  const dockerApiPatterns = [/\/var\/run\/docker\.sock/g, /\/containers\/(?:json|[^"']*\/json)/g, /\bsocketPath\s*:/g];
  for (const { file, text } of projectFiles) {
    if (
      invariantDocExclusions.has(file) ||
      file === "scripts/check-architecture.mjs" ||
      file.startsWith("docs/operator-guide/") ||
      file.startsWith("services/allocator/") ||
      file.startsWith("services/orchestrator/src/engine/allocators/") ||
      file.startsWith("services/orchestrator/tests/")
    ) {
      continue;
    }
    for (const dockerPattern of dockerApiPatterns) {
      for (const match of text.matchAll(dockerPattern)) {
        const lineNumber = lineFor(text, match.index);
        if (isComposeFile(file) && isAllowedAllocatorDockerSocketMount(file, text, lineNumber)) {
          continue;
        }
        diagnostics.push(
          diagnostic("docker-api-allocator-only", file, "Docker socket/API access is confined to local allocator code", lineNumber)
        );
      }
    }
  }
  return diagnostics;
}

function checkSingleEventWriter(projectFiles) {
  const diagnostics = [];
  const sqlInsert = new RegExp("INSERT\\s+INTO\\s+events", "gi");
  const drizzleInsert = /db\.insert\s*\(\s*events\s*\)/g;
  for (const { file, text } of projectFiles) {
    if (
      invariantDocExclusions.has(file) ||
      file === "services/orchestrator/src/engine/eventStore.ts" ||
      file.startsWith("db/migrations/")
    ) {
      continue;
    }
    for (const pattern of [sqlInsert, drizzleInsert]) {
      for (const match of text.matchAll(pattern)) {
        diagnostics.push(diagnostic("single-event-writer", file, "events may only be written through eventStore", lineFor(text, match.index)));
      }
    }
  }
  return diagnostics;
}

function checkFailureVariants(projectFiles) {
  const diagnostics = [];
  const failurePatterns = [/kind\s*:\s*["']host_[^"']+["']/g, /\|\s*["']host_[^"']+["']/g];
  for (const { file, text } of projectFiles) {
    if (invariantDocExclusions.has(file)) {
      continue;
    }
    for (const pattern of failurePatterns) {
      for (const match of text.matchAll(pattern)) {
        diagnostics.push(diagnostic("forbidden-failure-variants", file, "host-prefixed failure variants are forbidden", lineFor(text, match.index)));
      }
    }
  }
  return diagnostics;
}

function isRoleDispatcher(file) {
  return file.startsWith("services/orchestrator/src/engine/workflow/") || file.startsWith("services/orchestrator/src/engine/dispatchers/");
}

function checkWriterAnswererSeparation(projectFiles) {
  const diagnostics = [];
  for (const { file, text } of projectFiles) {
    if (!file.startsWith("services/orchestrator/src/") || file.includes("/providers/") || isRoleDispatcher(file)) {
      continue;
    }
    if (text.includes("runWriter") && text.includes("runAnswerer")) {
      diagnostics.push(diagnostic("writer-answerer-separation", file, "non-dispatcher code may not mix writer and answerer execution paths"));
    }
  }
  return diagnostics;
}

function checkCostSources(projectFiles) {
  const diagnostics = [];
  const legacy = new RegExp(`${"legacy"}_${"unknown"}`, "g");
  const sqlCheck = /cost_source\s+IN\s*\(([^)]*)\)/gi;
  for (const { file, text } of projectFiles) {
    if (invariantDocExclusions.has(file)) {
      continue;
    }
    for (const match of text.matchAll(legacy)) {
      diagnostics.push(diagnostic("no-unknown-cost-source", file, "placeholder cost sources are not allowed", lineFor(text, match.index)));
    }
    for (const match of text.matchAll(sqlCheck)) {
      const values = [...match[1].matchAll(/'([^']+)'/g)].map((value) => value[1]);
      const invalid = values.filter((value) => !costSources.has(value));
      if (invalid.length > 0 || values.length !== costSources.size) {
        diagnostics.push(
          diagnostic("no-unknown-cost-source", file, "cost_source checks must exactly match the accepted brief values", lineFor(text, match.index))
        );
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
      const pattern = new RegExp(`${action}@v(\\d+)`, "g");
      for (const match of text.matchAll(pattern)) {
        if (match[1] !== "6") {
          diagnostics.push(diagnostic("github-actions-current-major", file, `${action} must use verified major v6`, lineFor(text, match.index)));
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
  "services/orchestrator/src/engine/workflow/githubDraftPr.ts"
]);

function checkNoRowCastsInWorkflow(projectFiles) {
  const diagnostics = [];
  // Detect `... as Something` where the cast immediately follows .rows[N] or
  // a variable named `row`/`rows`. Allow `as const` casts (they're not row
  // shape casts) and exempt the explicit allowlist above.
  const rowCastPatterns = [
    /\.rows\[[^\]]*\]\s+as\s+(?!const\b)[A-Za-z_$]/g,
    /\brow\s+as\s+(?!const\b)[A-Za-z_$]/g
  ];
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
            lineFor(text, match.index)
          )
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
    return [diagnostic("state-drift-check-wired", "scripts/generate-state-checks.mjs", "state drift generator is missing")];
  }
  if (!packageFile) {
    return [diagnostic("state-drift-check-wired", "package.json", "root package.json is required for state drift wiring")];
  }
  try {
    const pkg = JSON.parse(packageFile.text);
    const scripts = pkg.scripts ?? {};
    const checkScript = String(scripts.check ?? "");
    const stateScript = String(scripts["check:state-drift"] ?? "");
    if (!stateScript.includes("scripts/generate-state-checks.mjs")) {
      return [
        diagnostic("state-drift-check-wired", "package.json", "check:state-drift must run scripts/generate-state-checks.mjs")
      ];
    }
    const rootCheckRunsStateDrift =
      checkScript.includes("check:state-drift") ||
      (checkScript.includes("just ci") && justfile?.text.includes("ci:") && justfile.text.includes("state-drift"));
    if (!rootCheckRunsStateDrift) {
      return [diagnostic("state-drift-check-wired", "package.json", "root check must include check:state-drift or delegate to just ci")];
    }
  } catch {
    return [diagnostic("state-drift-check-wired", "package.json", "root package.json must be valid JSON")];
  }
  return [];
}

function checkSchemaDriftWiring(projectFiles) {
  const packageFile = projectFiles.find((item) => item.file === "package.json");
  const justfile = projectFiles.find((item) => item.file === "justfile");
  const hasDriftScript = projectFiles.some((item) => item.file === "scripts/check-schema-drift.sh");
  if (!hasDriftScript) {
    return [diagnostic("schema-drift-check-wired", "scripts/check-schema-drift.sh", "schema drift check script is missing")];
  }

  if (!packageFile) {
    return [diagnostic("schema-drift-check-wired", "package.json", "root package.json is required for schema drift wiring")];
  }

  try {
    const pkg = JSON.parse(packageFile.text);
    const scripts = pkg.scripts ?? {};
    const checkScript = String(scripts.check ?? "");
    const driftScript = String(scripts["check:schema-drift"] ?? "");

    if (!driftScript.includes("scripts/check-schema-drift.sh")) {
      return [
        diagnostic("schema-drift-check-wired", "package.json", "check:schema-drift must run scripts/check-schema-drift.sh")
      ];
    }
    const rootCheckRunsSchemaDrift =
      checkScript.includes("check:schema-drift") ||
      (checkScript.includes("just ci") && justfile?.text.includes("ci:") && justfile.text.includes("schema-drift"));
    if (!rootCheckRunsSchemaDrift) {
      return [diagnostic("schema-drift-check-wired", "package.json", "root check must include check:schema-drift or delegate to just ci")];
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
    ...checkNoRowCastsInWorkflow(projectFiles)
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
