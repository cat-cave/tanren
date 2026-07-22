// Environment management (env-management.md §2.2 halt-loud, H1 finding #4) — the
// greenfield derive's EARLY-FEEDBACK JIT env-image guard. An off-baseline captured
// toolchain with NO `TANREN_ENV_REGISTRY` configured throws JitBuildRequiredError
// AT PROJECT-CREATE time rather than seeding an unusable project that fails
// mysteriously on the first run.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import {
  deriveFromCapture,
  emptyCapture,
  JitBuildRequiredError,
  type CaptureLifecycle,
  type InterviewCapture,
} from "../src/engine/forge/interview/index.js";
import { preparedDeploy, stubPool } from "./fixtures/forge/interviewDeriveStub.js";
import { completeCaptureExtras } from "./fixtures/forge/completeCapture.js";

const actor: ActorContext = {
  userId: "user_a",
  orgId: "org_a",
  projectId: null,
  scopes: ["platform:admin"],
  source: "session",
};

const TEST_REPO_URL = "https://github.com/cat-cave/off-baseline-project";

const MINIMAL_DESIGN_CONTRACT = {
  domain: "saas-web",
  identity: "a clean, trustworthy operations surface",
  intent: "a calm, information-dense control surface an operator trusts at a glance",
  principles: [],
  constraints: [],
  personas: [],
  behaviors: [],
  dimensions: [],
};

function offBaselineLifecycle(): CaptureLifecycle {
  return {
    stack: "rust/cargo",
    bootstrap: "cargo fetch",
    tier1: "cargo clippy",
    tier2: "cargo build && cargo test",
    tier3: "cargo clippy && cargo build && cargo test",
    build: "cargo build --release",
    deploy: "just deploy",
    upgrade: "cargo update",
    // Off the golden baseline (rust never warmed) → JIT capability REQUIRED.
    toolchain: [{ name: "rust", version: "nightly" }],
  };
}

function baselineSubsetLifecycle(): CaptureLifecycle {
  return {
    stack: "ts/pnpm",
    bootstrap: "pnpm install",
    tier1: "pnpm lint",
    tier2: "pnpm build && pnpm test",
    tier3: "pnpm lint && pnpm build && pnpm test",
    build: "pnpm build",
    deploy: "just deploy",
    upgrade: "pnpm update --latest",
    // Baseline-subset (apex-style) — the golden base already serves this, so no
    // JIT capability is required.
    toolchain: [
      { name: "node", version: "24" },
      { name: "pnpm", version: "11" },
    ],
  };
}

function captureWith(lifecycle: CaptureLifecycle): InterviewCapture {
  return {
    ...emptyCapture(),
    ...completeCaptureExtras(),
    lifecycle,
    designContract: MINIMAL_DESIGN_CONTRACT,
  };
}

describe("greenfield derive · JIT env-image guard (H1 #4 — halt loud at project-create)", () => {
  const originalRegistry = process.env["TANREN_ENV_REGISTRY"];
  beforeEach(() => {
    delete process.env["TANREN_ENV_REGISTRY"];
  });
  afterEach(() => {
    if (originalRegistry === undefined) {
      delete process.env["TANREN_ENV_REGISTRY"];
    } else {
      process.env["TANREN_ENV_REGISTRY"] = originalRegistry;
    }
  });

  it("THROWS JitBuildRequiredError on an off-baseline captured toolchain when the registry is unset", async () => {
    const { pool, state } = stubPool();
    await expect(
      deriveFromCapture(
        { pool },
        {
          orgId: "org_a",
          capture: captureWith(offBaselineLifecycle()),
          actor,
          repoUrl: TEST_REPO_URL,
          deploy: { providerKind: "deploy.vercel" },
        },
      ),
    ).rejects.toBeInstanceOf(JitBuildRequiredError);
    // No project row landed — the guard fires BEFORE any resource-creating work.
    expect(state.projects.size).toBe(0);
  });

  it("PASSES the guard on a baseline-subset toolchain even when the registry is unset (apex-style)", async () => {
    // A baseline-subset toolchain does not need JIT; the derive should not throw
    // JitBuildRequiredError. It may throw for other reasons (missing prepareDeploy
    // in this minimal test wiring) but NOT the JIT guard.
    const { pool } = stubPool();
    let caught: unknown;
    try {
      await deriveFromCapture(
        { pool },
        {
          orgId: "org_a",
          capture: captureWith(baselineSubsetLifecycle()),
          actor,
          repoUrl: TEST_REPO_URL,
          deploy: { providerKind: "deploy.vercel" },
          async prepareDeploy(request) {
            return preparedDeploy(request.providerKind as "deploy.vercel" | "deploy.flyio");
          },
        },
      );
    } catch (error) {
      caught = error;
    }
    // Whatever went wrong (or didn't), it MUST NOT be the JIT guard: a
    // baseline-subset toolchain requires no JIT capability.
    expect(caught).not.toBeInstanceOf(JitBuildRequiredError);
  });

  it("PASSES the guard on an off-baseline toolchain when TANREN_ENV_REGISTRY IS configured", async () => {
    process.env["TANREN_ENV_REGISTRY"] = "registry:5000";
    const { pool } = stubPool();
    let caught: unknown;
    try {
      await deriveFromCapture(
        { pool },
        {
          orgId: "org_a",
          capture: captureWith(offBaselineLifecycle()),
          actor,
          repoUrl: TEST_REPO_URL,
          deploy: { providerKind: "deploy.vercel" },
          async prepareDeploy(request) {
            return preparedDeploy(request.providerKind as "deploy.vercel" | "deploy.flyio");
          },
        },
      );
    } catch (error) {
      caught = error;
    }
    // With the registry configured the JIT guard passes silently; downstream
    // failures are unrelated to this guard.
    expect(caught).not.toBeInstanceOf(JitBuildRequiredError);
  });
});
