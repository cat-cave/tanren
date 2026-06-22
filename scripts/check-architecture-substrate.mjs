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
  const importPattern = /(?:from\s+|import\s*\(|require\s*\()\s*["'](?:node:)?child_process["']/gu;
  for (const { file, text } of projectFiles) {
    if (
      invariantDocExclusions.has(file) ||
      file.startsWith("services/orchestrator/src/engine/cli-runner/") ||
      file.startsWith("scripts/") ||
      // The JIT env-image build driver (env-management.md §4 + §7 P4) is a confined
      // host-process-spawn capability, the same category as cli-runner: it shells the
      // BuildKit build (`build-env-image.sh`) on the ORCHESTRATOR HOST (where
      // docker/buildx + the registry live), exactly as the golden-image refresh does.
      // This is NOT workload execution (that still routes through the SSH
      // CommandSubstrate seam, which this driver does not touch) — it is an
      // image-build seam, analogous to a `just build-golden-image` run, surfaced as an
      // orchestrator-driven seam rather than a hand-run script. The ban targets
      // engine WORKLOAD spawning, not the host-side image build; this single driver is
      // the only env-creation file permitted to import child_process.
      file === "services/orchestrator/src/engine/environments/creation/liveEnvBuildDriver.ts" ||
      // Test fixtures may spawn local processes: the ban targets the ENGINE (which
      // must route through the CommandSubstrate seam), not a tests/ fixture that
      // IMPLEMENTS a local CommandSubstrate to drive a real git/jj process in a
      // conformance suite (the test-only arm of the substrate seam).
      file.includes("/tests/")
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
  const execPatterns = [/container\.exec\s*\(/gu, /\bdocker\s+exec\b/gu];
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
  return /^(\/|\.{1,2}\/|~\/|\$\{?(?:PWD|HOME)\}?|[A-Za-z]:[\\/])/u.test(source);
}

export function checkNoHostBindMounts(projectFiles) {
  const diagnostics = [];
  const apiPatterns = [/\bBinds\b\s*:/gu, /\bMounts\b\s*:/gu, /\btype\s*[:=]\s*["']?bind["']?/gu];
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
      const match = line.match(/^\s*-\s*["']?([^"'\s:]+):\/[^"']*["']?\s*$/u);
      if (match && isAllowedAllocatorDockerSocketMount(file, text, index + 1)) {
        return;
      }
      // The control↔data-plane mTLS certs are supplied to the
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

// The allocator service binds the container-runtime socket. Docker hosts use the
// literal `/var/run/docker.sock`; rootless podman uses
// `/run/user/$UID/podman/podman.sock` (selected via TANREN_DOCKER_SOCK and
// auto-detected by `just up-dev`). Both shapes are allowed on the SAME mount
// line inside the allocator service; the lint's job is to keep the socket out
// of every OTHER service + every runtime code path.
function isAllowedDockerSocketMount(file, line) {
  if (!isComposeFile(file)) return false;
  const trimmed = line.trim();
  return (
    trimmed === "- /var/run/docker.sock:/var/run/docker.sock" ||
    trimmed === "- ${TANREN_DOCKER_SOCK:-/var/run/docker.sock}:/var/run/docker.sock"
  );
}

// A read-only mount of the dev mTLS cert dir into the control /
// data plane at /etc/tanren/mtls. Allowed as config (not workload substrate).
function isAllowedMtlsCertMount(file, line) {
  return isComposeFile(file) && /^\s*-\s*\/tmp\/tanren-mtls:\/etc\/tanren\/mtls:ro\s*$/u.test(line);
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
    const serviceMatch = line.match(/^  ([a-zA-Z0-9_-]+):\s*$/u);
    if (serviceMatch) {
      currentService = serviceMatch[1];
      inVolumes = false;
      continue;
    }
    if (/^    volumes:\s*$/u.test(line)) {
      inVolumes = currentService === "allocator";
      continue;
    }
    if (/^    [a-zA-Z0-9_-]+:/u.test(line)) {
      inVolumes = false;
    }
  }

  return currentService === "allocator" && inVolumes && isAllowedDockerSocketMount(file, lines[lineNumber - 1] ?? "");
}

export function checkDockerApiAllocatorOnly(projectFiles) {
  const diagnostics = [];
  const dockerApiPatterns = [
    /\/var\/run\/docker\.sock/gu,
    /\/containers\/(?:json|[^"']*\/json)/gu,
    /\bsocketPath\s*:/gu,
  ];
  for (const { file, text } of projectFiles) {
    if (
      invariantDocExclusions.has(file) ||
      file === "scripts/check-architecture.mjs" ||
      file === "scripts/check-architecture-substrate.mjs" ||
      // justfile resolves TANREN_DOCKER_SOCK (docker default + rootless-podman
      // fallback) and passes it into compose as an env var. This is operator-side
      // path detection, not runtime data-plane socket access; the lint's "confined
      // to allocator code" rule guards the latter and tolerates the former.
      file === "justfile" ||
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
