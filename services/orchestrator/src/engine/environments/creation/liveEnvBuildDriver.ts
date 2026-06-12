// Environment management (environment-management.md §4 + §7 P4) — the LIVE
// `EnvImageBuildDriver` impl: it drives the BuildKit env-image build by shelling the
// `scripts/dev/build-env-image.sh` recipe (the env counterpart of P2's
// build-golden-image.sh), capturing the pushed image ref the script emits on its last
// line. The build runs on the ORCHESTRATOR HOST (where docker/buildx + the registry
// live), exactly as the golden-image refresh does — it is NOT a runner-side command.
//
// REUSE, never reinvent: the script carries the whole BuildKit recipe (the
// docker-container builder, the insecure-local-registry buildkitd config, the
// mode=max cache). This module is ONLY the typed seam onto it + the fail-loud
// handoff: a non-zero exit, a missing image ref, or a spawn failure throws
// `EnvBuildFailedError` so the creation flow aborts WITHOUT publishing.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../../observability/logger.js";
import {
  type BuiltEnvImage,
  type EnvBuildRequest,
  EnvBuildFailedError,
  type EnvImageBuildDriver,
} from "./envBuildDriver.js";

const execFileAsync = promisify(execFile);
const log = createLogger("env-build");

// The deps the live driver needs — injected so the production wiring supplies the real
// script path + registry knobs and a test can assert the wiring without a live build.
export interface LiveEnvBuildDriverDeps {
  // Absolute path to build-env-image.sh.
  scriptPath: string;
  // The registry host to tag/push to (`registry:5000` in dev / GHCR in prod). Passed
  // to the script as REGISTRY.
  registry: string;
  // The image repo name under the registry (default `tanren-env`).
  imageName?: string;
  // Whether to PUSH the built image to the registry. The live path ALWAYS pushes (the
  // validation harness allocates a runner FROM the registry ref); a local-only build
  // (PUSH=0) is for an operator dry-run.
  push: boolean;
  // The build timeout (a cold off-baseline toolchain install can take minutes).
  timeoutMs: number;
}

// Build the production `EnvImageBuildDriver`. The returned driver materializes the
// project's mise.toml to a temp file, invokes the build script with the golden base +
// env_key + registry knobs, and captures the pushed image ref. LOUD on any failure.
export function buildLiveEnvBuildDriver(deps: LiveEnvBuildDriverDeps): EnvImageBuildDriver {
  return {
    async build(request: EnvBuildRequest): Promise<BuiltEnvImage> {
      // Materialize the rendered mise.toml to a temp file the script COPYs into the
      // build context. The temp dir is removed in a finally (never leaked).
      const dir = await mkdtemp(join(tmpdir(), "tanren-env-build-"));
      const miseTomlPath = join(dir, "mise.toml");
      try {
        await writeFile(miseTomlPath, request.miseToml, "utf8");
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          GOLDEN_BASE_IMAGE: request.goldenBaseImage,
          MISE_TOML_PATH: miseTomlPath,
          ENV_KEY: request.envKey,
          REGISTRY: deps.registry,
          PUSH: deps.push ? "1" : "0",
          ...(deps.imageName === undefined ? {} : { IMAGE_NAME: deps.imageName }),
        };
        let stdout: string;
        try {
          const result = await execFileAsync("bash", [deps.scriptPath], {
            env,
            timeout: deps.timeoutMs,
            maxBuffer: 32 * 1024 * 1024,
          });
          stdout = result.stdout;
        } catch (error) {
          // A non-zero exit / timeout / spawn error — LOUD, never a silent degrade to
          // the golden base for an off-baseline toolchain that demanded a real env.
          throw new EnvBuildFailedError(
            request.envKey,
            error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          );
        }
        // The script emits the pushed image ref on its LAST non-empty line.
        const imageRef = lastNonEmptyLine(stdout);
        if (imageRef === undefined || !imageRef.includes(deps.registry)) {
          throw new EnvBuildFailedError(
            request.envKey,
            `the build script produced no usable image ref (last line: ${JSON.stringify(imageRef)})`,
          );
        }
        log.info("built + pushed env image", { envKey: request.envKey, imageRef });
        return { imageRef, envKey: request.envKey };
      } finally {
        await rm(dir, { recursive: true, force: true }).catch((error: unknown) => {
          log.warn("failed to remove env-build temp dir", { dir }, error);
        });
      }
    },
  };
}

// The build script's image ref is its last non-empty stdout line. Trim + return it, or
// undefined when stdout is empty (a LOUD failure at the call site).
function lastNonEmptyLine(stdout: string): string | undefined {
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.at(-1);
}
