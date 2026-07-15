// Substrate-isolation architecture checks (extracted from check-architecture.mjs
// to keep both files under the 500-line cap). These guard the v0 invariant that
// workload execution stays inside the runner over SSH and that Docker
// socket/API access is confined to the local allocator. Heuristic regex + line
// scanners in the same style as the sibling check modules. The process-import
// rule uses Oxc AST traversal so source-text lookalikes are not imports.

import { parseSync } from "oxc-parser";

const invariantDocExclusions = new Set(["PROJECT_BRIEF.md", "docs/contracts/architecture-checks.md"]);

function diagnostic(rule, file, message, line = 1) {
  return { rule, file, line, message };
}

function lineFor(text, index) {
  return text.slice(0, index).split("\n").length;
}

const dependencySourceNodeTypes = new Set(
  "ImportDeclaration ExportNamedDeclaration ExportAllDeclaration ImportExpression".split(" "),
);

function childProcessSpecifiers(file, text) {
  const sourceFile = parseSync(file, text, { range: true, sourceType: "unambiguous" });
  const specifiers = [];
  const add = (node) => {
    if (node?.type === "Literal" && (node.value === "child_process" || node.value === "node:child_process")) {
      specifiers.push(node.start);
    }
  };
  const visit = (node) => {
    if (node === null || typeof node !== "object") return;
    if (dependencySourceNodeTypes.has(node.type)) add(node.source);
    else if (node.type === "TSImportEqualsDeclaration" && node.moduleReference?.type === "TSExternalModuleReference")
      add(node.moduleReference.expression);
    else if (
      node.type === "CallExpression" &&
      node.callee?.type === "Identifier" &&
      node.callee.name === "require" &&
      node.arguments.length === 1
    )
      add(node.arguments[0]);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) {
          visit(child);
        }
      } else {
        visit(value);
      }
    }
  };
  visit(sourceFile.program);
  return specifiers;
}

export function checkNoHostProcessSpawn(projectFiles) {
  const diagnostics = [];
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
      // The live Fly image-build driver (PR3) is the deploy-layer counterpart of
      // liveEnvBuildDriver: a confined host-side image-build seam that shells
      // build-deploy-image.sh on the ORCHESTRATOR HOST to build+push the merged commit
      // to registry.fly.io. It is NOT workload execution (that still routes through the
      // SSH CommandSubstrate seam) — it is a deploy-image build, analogous to a
      // `just deploy` run. It exports its real side-effect bindings so the config reader
      // (flyImageBuilderConfig.ts) wires them WITHOUT importing child_process itself; only
      // THIS file imports child_process (the exec runner + tar extraction).
      file === "services/orchestrator/src/engine/provisioners/liveFlyImageBuilder.ts" ||
      // The F2 runtime-validity smoke's LIVE invoker (fragment authoring, not workload
      // execution). It spawns pnpm/bundle on the ORCHESTRATOR HOST to prove an
      // authored fragment's manifest is runtime-resolvable BEFORE the fragment
      // persists — analogous in spirit to `liveEnvBuildDriver.ts`: host-side
      // AUTHORING-TIME validation, not runtime workload execution over SSH. The
      // production shim + the fake (test-injected) invoker share the seam types
      // in `runtimeValiditySmoke.ts`; only THIS file imports child_process.
      file === "services/orchestrator/src/engine/templates/fragments/runtimeValiditySmokeLive.ts" ||
      // Test fixtures may spawn local processes: the ban targets the ENGINE (which
      // must route through the CommandSubstrate seam), not a tests/ fixture that
      // IMPLEMENTS a local CommandSubstrate to drive a real git/jj process in a
      // conformance suite (the test-only arm of the substrate seam).
      file.includes("/tests/")
    ) {
      continue;
    }
    for (const index of childProcessSpecifiers(file, text)) {
      diagnostics.push(
        diagnostic(
          "no-host-process-spawn",
          file,
          "child_process imports are confined to cli-runner",
          lineFor(text, index),
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
