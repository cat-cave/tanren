// Substrate-isolation architecture checks (extracted from check-architecture.mjs
// to keep both files under the 500-line cap). These guard the v0 invariant that
// workload execution stays inside the runner over SSH and that Docker
// socket/API access is confined to the local allocator. Heuristic regex + line
// scanners in the same style as the sibling check modules.

const invariantDocExclusions = new Set(["PROJECT_BRIEF.md", "docs/contracts/architecture-checks.md"]);

function diagnostic(rule, file, message, line = 1) {
  return { rule, file, line, message };
}

function lineFor(text, index) {
  return text.slice(0, index).split("\n").length;
}

export function checkNoHostProcessSpawn(projectFiles) {
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
        diagnostic(
          "no-host-process-spawn",
          file,
          "child_process imports are confined to cli-runner",
          lineFor(text, match.index),
        ),
      );
    }
  }
  return diagnostics;
}

export function checkNoDockerExec(projectFiles) {
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
          diagnostic(
            "no-docker-exec-for-workloads",
            file,
            "workload execution must go through SSH",
            lineFor(text, match.index),
          ),
        );
      }
    }
  }
  return diagnostics;
}

function isHostPath(source) {
  return /^(\/|\.{1,2}\/|~\/|\$\{?(?:PWD|HOME)\}?|[A-Za-z]:[\\/])/.test(source);
}

export function checkNoHostBindMounts(projectFiles) {
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
        diagnostics.push(
          diagnostic("no-host-bind-mounts", file, "host bind mounts are not allowed", lineFor(text, match.index)),
        );
      }
    }
    text.split("\n").forEach((line, index) => {
      const match = line.match(/^\s*-\s*["']?([^"'\s:]+):\/[^"']*["']?\s*$/);
      if (match && isAllowedAllocatorDockerSocketMount(file, text, index + 1)) {
        return;
      }
      // Plane-split P2: the control↔data-plane mTLS certs are supplied to the
      // orchestrator + worker as a READ-ONLY mount of the dev cert dir at
      // /etc/tanren/mtls. This is config material, not workload-execution
      // substrate (the invariant this rule guards), so it is allowed.
      if (match && isAllowedMtlsCertMount(file, line)) {
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

// Plane-split P2: a read-only mount of the dev mTLS cert dir into the control /
// data plane at /etc/tanren/mtls. Allowed as config (not workload substrate).
function isAllowedMtlsCertMount(file, line) {
  return isComposeFile(file) && /^\s*-\s*\/tmp\/tanren-mtls:\/etc\/tanren\/mtls:ro\s*$/.test(line);
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

export function checkDockerApiAllocatorOnly(projectFiles) {
  const diagnostics = [];
  const dockerApiPatterns = [/\/var\/run\/docker\.sock/g, /\/containers\/(?:json|[^"']*\/json)/g, /\bsocketPath\s*:/g];
  for (const { file, text } of projectFiles) {
    if (
      invariantDocExclusions.has(file) ||
      file === "scripts/check-architecture.mjs" ||
      file === "scripts/check-architecture-substrate.mjs" ||
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
          diagnostic(
            "docker-api-allocator-only",
            file,
            "Docker socket/API access is confined to local allocator code",
            lineNumber,
          ),
        );
      }
    }
  }
  return diagnostics;
}
