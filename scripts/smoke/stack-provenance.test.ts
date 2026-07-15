import { describe, expect, it } from "vitest";
import { createStackContext, probeBindings, resolveHostPorts, withExecutionRoot } from "./stack-context.js";
import {
  assertGitIdentity,
  assertGitWorktreeClean,
  assertProbeBindings,
  assertRegistryHealth,
  assertSemanticHealth,
  assertStableContainers,
  BUILD_ID_LABEL,
  BUILT_SERVICES,
  REVISION_LABEL,
  SERVICE_LABEL,
  STACK_SERVICES,
  TREE_LABEL,
  validateBuiltImages,
  validateContainers,
} from "./stack-provenance.js";

const HEAD = "a".repeat(40);
const TREE = "b".repeat(40);

const context = createStackContext({
  root: "/repo/candidate",
  head: HEAD,
  tree: TREE,
  runId: "candidate-1",
  nonce: "c".repeat(32),
  runtimeBase: "/runtime",
  receiptPath: "/receipt.json",
  ports: resolveHostPorts({}, 1200),
});

function imageInspect(overrides: Partial<Record<(typeof BUILT_SERVICES)[number], Record<string, string>>> = {}) {
  return JSON.stringify(
    BUILT_SERVICES.map((service, index) => ({
      Id: `sha256:${String(index + 1).repeat(64)}`,
      Config: {
        Labels: {
          [BUILD_ID_LABEL]: context.buildId,
          [SERVICE_LABEL]: service,
          [REVISION_LABEL]: HEAD,
          [TREE_LABEL]: TREE,
          ...overrides[service],
        },
      },
    })),
  );
}

function container(
  service: (typeof STACK_SERVICES)[number],
  options: { project?: string; imageId?: string; status?: string; workingDir?: string; publicBaseUrl?: string } = {},
) {
  const builtIndex = BUILT_SERVICES.indexOf(service as (typeof BUILT_SERVICES)[number]);
  const imageId = options.imageId ?? (builtIndex >= 0 ? String(builtIndex + 1).repeat(64) : "f".repeat(64));
  return {
    Id: `${service.codePointAt(0)!.toString(16)}`.repeat(64).slice(0, 64),
    Image: `sha256:${imageId}`,
    Config: {
      Env:
        service === "orchestrator"
          ? [`TANREN_PUBLIC_BASE_URL=${options.publicBaseUrl ?? context.endpoints.orchestrator}`]
          : [],
      Labels: {
        "com.docker.compose.project": options.project ?? context.project,
        "com.docker.compose.service": service,
        "com.docker.compose.project.working_dir": options.workingDir ?? context.root,
      },
    },
    State: { Status: options.status ?? "running", Running: (options.status ?? "running") === "running" },
  };
}

function containerInspect() {
  return JSON.stringify(STACK_SERVICES.map((service) => container(service)));
}

describe("smoke stack provenance", () => {
  it("accepts only the complete candidate image and container set", () => {
    const images = validateBuiltImages(context, imageInspect());
    const containers = validateContainers(context, images, containerInspect());
    expect(Object.keys(images).sort()).toEqual([...BUILT_SERVICES].sort());
    expect(Object.keys(containers).sort()).toEqual([...STACK_SERVICES].sort());
  });

  it("binds Compose working-directory provenance to the verified archive", () => {
    const archived = withExecutionRoot(context, "/verified/archive");
    const images = validateBuiltImages(archived, imageInspect());
    const containers = STACK_SERVICES.map((service) => container(service, { workingDir: archived.executionRoot }));
    expect(() => validateContainers(archived, images, JSON.stringify(containers))).not.toThrow();
    expect(() => validateContainers(archived, images, containerInspect())).toThrow(/working directory/u);
  });

  it("rejects a healthy decoy when the candidate container is stopped", () => {
    const images = validateBuiltImages(context, imageInspect());
    const candidate = STACK_SERVICES.map((service) =>
      service === "orchestrator" ? container(service, { status: "exited" }) : container(service),
    );
    const decoy = container("orchestrator", { project: "tanren", workingDir: "/repo/default" });
    expect(() => validateContainers(context, images, JSON.stringify([...candidate, decoy]))).toThrow(
      /orchestrator container state inconsistent or not running/u,
    );
  });

  it("rejects wrong revision, image, project, and worktree identity", () => {
    expect(() => validateBuiltImages(context, imageInspect({ worker: { [REVISION_LABEL]: "c".repeat(40) } }))).toThrow(
      /provenance mismatch/u,
    );
    const images = validateBuiltImages(context, imageInspect());
    const wrongImage = STACK_SERVICES.map((service) =>
      service === "runner" ? container(service, { imageId: "9".repeat(64) }) : container(service),
    );
    expect(() => validateContainers(context, images, JSON.stringify(wrongImage))).toThrow(/freshly built/u);
    const wrongProject = STACK_SERVICES.map((service) => container(service, { project: "tanren" }));
    expect(() => validateContainers(context, images, JSON.stringify(wrongProject))).toThrow(
      /missing running services/u,
    );
    const wrongRoot = STACK_SERVICES.map((service) =>
      service === "dashboard" ? container(service, { workingDir: "/repo/decoy" }) : container(service),
    );
    expect(() => validateContainers(context, images, JSON.stringify(wrongRoot))).toThrow(/working directory/u);
  });

  it("rejects HEAD drift and a container replacement after probes", () => {
    expect(() => assertGitIdentity(context, "c".repeat(40), TREE)).toThrow(/Git identity changed/u);
    expect(() => assertGitWorktreeClean(" M services/orchestrator/src/main.ts\n")).toThrow(/worktree changed/u);
    const images = validateBuiltImages(context, imageInspect());
    const initial = validateContainers(context, images, containerInspect());
    const replaced = structuredClone(initial);
    replaced.worker.containerId = "e".repeat(64);
    expect(() => assertStableContainers(initial, replaced)).toThrow(/worker container\/image changed/u);
  });

  it("rejects an orchestrator still configured for a stale default public URL", () => {
    const images = validateBuiltImages(context, imageInspect());
    const stale = STACK_SERVICES.map((service) =>
      service === "orchestrator" ? container(service, { publicBaseUrl: "http://127.0.0.1:3100" }) : container(service),
    );
    expect(() => validateContainers(context, images, JSON.stringify(stale))).toThrow(/expected discovered candidate/u);
  });

  it("requires semantic health instead of status-only responses", () => {
    expect(() =>
      assertSemanticHealth("orchestrator", { ok: true, database: "ok", vault: { ok: true, status: 200 } }),
    ).not.toThrow();
    expect(() =>
      assertSemanticHealth("orchestrator", { ok: false, database: "ok", vault: { ok: false, status: 503 } }),
    ).toThrow(/not semantically green/u);
    expect(() => assertSemanticHealth("dashboard", { ok: true, orchestrator: false })).toThrow(
      /not semantically green/u,
    );
    expect(() => assertSemanticHealth("allocator", { ok: false })).toThrow(/not semantically green/u);
    expect(() => assertSemanticHealth("vault", { initialized: true, sealed: true })).toThrow(/not ready/u);
    expect(() => assertSemanticHealth("unknown", {})).toThrow(/unsupported/u);
    expect(() => assertRegistryHealth(new Response("{}", { status: 200 }))).toThrow(/not semantic/u);
    expect(() =>
      assertRegistryHealth(
        new Response("{}", {
          status: 200,
          headers: { "Docker-Distribution-Api-Version": "registry/2.0" },
        }),
      ),
    ).not.toThrow();
  });

  it("rejects a receipt whose probes name decoy bindings", () => {
    const actual = probeBindings(context);
    actual["orchestrator"] = "http://127.0.0.1:3100/healthz";
    expect(() => assertProbeBindings(context, actual)).toThrow(/expected candidate/u);
  });
});
