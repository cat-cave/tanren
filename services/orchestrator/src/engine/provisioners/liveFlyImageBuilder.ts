// The LIVE `FlyImageBuilder` impl (PR3): it builds the merged commit into
// `registry.fly.io/<app>:<sha>` on the ORCHESTRATOR HOST and pushes it. This is the
// deploy-layer counterpart of `engine/environments/creation/liveEnvBuildDriver.ts`:
// a typed seam onto a host-side BuildKit build (`scripts/dev/build-deploy-image.sh`)
// that captures the pushed image ref the script emits on its last line.
//
// UNLIKE `liveEnvBuildDriver` (which uses `execFile`/`fs` directly and is exercised at
// the SEAM level in tests), THIS driver INJECTS every side-effecting dep via the ctor —
// the minted GitHub source-token, the tarball fetch, the tar extract, the exec runner,
// the tmp-dir/fs seams — so the unit suite can prove the wiring (mints the token for the
// repo, fetches `/repos/{owner}/{repo}/tarball/{sha}` with it, shells the script with
// `APP/SHA/FLY_TOKEN/CONTEXT`, parses the ref) with NO docker / NO GitHub / NO network.
// The production bindings (`realFlyImageBuilderSideEffects`) are exported alongside so
// the config reader (`flyImageBuilderConfig.ts`) wires the real execFile/fs/tar/fetch
// without itself importing `child_process` (mirroring envCreationConfig's clean split).
//
// SECRET DISCIPLINE (this path handles a Fly registry token + a GitHub installation
// token): the Fly token (`request.flyToken`) flows ONLY into the script's `FLY_TOKEN`
// env var (which the script feeds to `docker login --password-stdin`, never echoing it).
// The GitHub token mints ONLY the tarball-fetch `Authorization` header. NEITHER token is
// ever logged, returned, or interpolated into a thrown message — `sanitizeCause` strips
// the Fly token from any error cause as belt-and-suspenders, and the GitHub token never
// leaves the `Authorization` header (not in the URL, not in any output). A failure
// throws {@link FlyImageBuildFailedError} naming ONLY the app + ref — never a token.

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../observability/logger.js";
import {
  type BuiltDeployImage,
  FlyImageBuildFailedError,
  type FlyImageBuildRequest,
  type FlyImageBuilder,
} from "./flyImageBuilder.js";

const execFileAsync = promisify(execFileCb);
const log = createLogger("fly-image-build");

// The GitHub tarball endpoint for a merged commit (302-redirects to codeload). The token
// rides ONLY in the `Authorization` header (never the URL), so the URL is safe to log.
export function githubTarballUrl(repo: string, ref: string): string {
  return `https://api.github.com/repos/${repo}/tarball/${ref}`;
}

/**
 * The deps a live Fly image build runs over — ALL side-effecting seams injected so the
 * unit suite wires fakes (no docker / no GitHub / no network). The production bindings
 * come from {@link realFlyImageBuilderSideEffects}. Mirrors how `liveEnvBuildDriver`
 * confines its knobs to a single deps object, but goes further (every I/O seam is
 * injectable) because this driver's side-effect surface is broader (GitHub + docker).
 */
export interface LiveFlyImageBuilderDeps {
  /** Absolute path to `scripts/dev/build-deploy-image.sh`. */
  scriptPath: string;
  /**
   * Mint a GitHub App installation token for `owner/name` — used ONLY as the bearer for
   * the tarball fetch. Production wires this over the shared `GithubAppTokenMinter`
   * (repo → installation → token); the test injects a fake that records the repo.
   */
  mintSourceToken: (repo: string) => Promise<string>;
  /**
   * Fetch the merged-commit source tarball bytes given the authed URL + token. Production
   * uses `fetch` (following the 302 to codeload); the test injects a fake. The token
   * travels ONLY in the request's `Authorization` header (never the URL / never returned).
   */
  fetchTarball: (url: string, token: string) => Promise<Uint8Array>;
  /**
   * Extract the GitHub tarball into the build-context dir (stripping the GitHub
   * top-level `{owner}-{repo}-{sha}/` wrapper so the source — incl. `Dockerfile` — lands
   * at the dir root). Production shells `tar -xzf --strip-components=1`; the test fakes it.
   */
  extractTarball: (tarball: Uint8Array, destDir: string) => Promise<void>;
  /**
   * Run the build script. Production = promisified `execFile`; the test injects a fake so
   * a non-zero exit (FlyImageBuildFailedError) is driven without docker. The `env` carries
   * `APP/SHA/FLY_TOKEN/CONTEXT` — the script reads the token from env + feeds it to
   * `docker login --password-stdin` (never argv, never echoed).
   */
  execFile: (file: string, args: readonly string[], options: { env: NodeJS.ProcessEnv }) => Promise<{ stdout: string }>;
  /** Make a temp build-context dir. Production = `mkdtemp`; the test fakes it. */
  makeTempDir: () => Promise<string>;
  /** Ensure the context has a `Dockerfile` (fail loud pre-build). Production = `access`. */
  assertDockerfilePresent: (dir: string) => Promise<void>;
  /** Remove the temp dir (best-effort; never throws on cleanup). Production = `rm -rf`. */
  removeDir: (dir: string) => Promise<void>;
}

/**
 * Build the live `FlyImageBuilder`. The returned driver mints a GitHub token for the
 * merged repo, fetches + extracts the source tarball into a temp build-context, shells
 * `build-deploy-image.sh` to build+push `registry.fly.io/<app>:<sha>`, and captures the
 * pushed ref the script emits on its last line. LOUD on any failure
 * ({@link FlyImageBuildFailedError}) — never a token in the thrown message.
 */
export function buildLiveFlyImageBuilder(deps: LiveFlyImageBuilderDeps): FlyImageBuilder {
  return {
    async build(request: FlyImageBuildRequest): Promise<BuiltDeployImage> {
      const dir = await deps.makeTempDir();
      try {
        const imageRef = await buildPushedImage(request, dir, deps);
        return { imageRef };
      } finally {
        await deps.removeDir(dir).catch((error: unknown) => {
          log.warn("failed to remove fly-build temp dir", { dir }, error);
        });
      }
    },
  };
}

/**
 * The inner build+push flow — returns the pushed image ref, or throws
 * {@link FlyImageBuildFailedError} on ANY failure (never a token in the message). A step
 * that already threw `FlyImageBuildFailedError` propagates as-is; any other error is
 * rewrapped with the app + ref so the caller sees the diagnostic coordinates.
 */
async function buildPushedImage(
  request: FlyImageBuildRequest,
  dir: string,
  deps: LiveFlyImageBuilderDeps,
): Promise<string> {
  const { repo, ref, appName, flyToken } = request;
  // Declared out here so the catch can redact it too (belt-and-suspenders): no reachable
  // path stringifies it today, but a future error path must never leak the source token.
  let sourceToken: string | undefined;
  try {
    // Mint a GitHub token for the merged repo — the tarball fetch's bearer. The token is
    // held in a local + the fetch's Authorization header only; never logged/returned.
    sourceToken = await deps.mintSourceToken(repo);
    const tarballUrl = githubTarballUrl(repo, ref);
    const tarball = await deps.fetchTarball(tarballUrl, sourceToken);
    await deps.extractTarball(tarball, dir);
    await deps.assertDockerfilePresent(dir);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      APP: appName,
      SHA: ref,
      FLY_TOKEN: flyToken,
      CONTEXT: dir,
    };
    const result = await deps.execFile("bash", [deps.scriptPath], { env });
    const imageRef = lastNonEmptyLine(result.stdout);
    if (imageRef === undefined || !imageRef.includes("registry.fly.io")) {
      throw new FlyImageBuildFailedError(
        appName,
        ref,
        `the build script produced no usable image ref (last line: ${JSON.stringify(imageRef)})`,
      );
    }
    log.info("built + pushed fly image", { appName, ref });
    return imageRef;
  } catch (error) {
    if (error instanceof FlyImageBuildFailedError) {
      throw error;
    }
    throw new FlyImageBuildFailedError(appName, ref, sanitizeCause(describe(error), flyToken, sourceToken));
  }
}

/**
 * The production side-effect bindings for {@link LiveFlyImageBuilderDeps} (everything
 * EXCEPT `scriptPath` + `mintSourceToken`, which the config reader supplies). Exported so
 * `flyImageBuilderConfig.ts` wires the real execFile/fs/tar/fetch WITHOUT importing
 * `child_process` itself — this is the one confined host-side image-build file permitted
 * to import `child_process` (mirroring `liveEnvBuildDriver.ts`; see architecture-checks.md).
 */
export function realFlyImageBuilderSideEffects(): Pick<
  LiveFlyImageBuilderDeps,
  "execFile" | "fetchTarball" | "extractTarball" | "makeTempDir" | "assertDockerfilePresent" | "removeDir"
> {
  return {
    execFile: async (file, args, options) =>
      execFileAsync(file, args, { ...options, maxBuffer: 32 * 1024 * 1024 }).then((r) => ({ stdout: r.stdout })),
    fetchTarball: realFetchTarball,
    extractTarball: realExtractTarball,
    makeTempDir: () => mkdtemp(join(tmpdir(), "tanren-fly-build-")),
    assertDockerfilePresent: async (dir) => {
      await access(join(dir, "Dockerfile"));
    },
    removeDir: (dir) => rm(dir, { recursive: true, force: true }),
  };
}

// Fetch the merged-commit tarball following the 302 to codeload (fetch follows by
// default). The token rides ONLY in the `Authorization` header. Returns the gzipped-tar
// bytes; the caller extracts them.
async function realFetchTarball(url: string, token: string): Promise<Uint8Array> {
  const response = await fetch(url, {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`fetch tarball failed: HTTP ${response.status} ${response.statusText}`);
  }
  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}

// Extract a GitHub tarball into `destDir`, stripping the top-level
// `{owner}-{repo}-{sha}/` wrapper (`--strip-components=1`) so the source — incl. the
// `Dockerfile` the build needs — lands at the dir root. The bytes are written to a temp
// file (outside the context so docker never sees it) then `tar` extracts from it.
// TRAVERSAL: the archive is the merge-GATED product source (not arbitrary attacker input),
// and GNU/bsd `tar` drops members with `..`/absolute paths by default (no `-P`), so an
// extracted path cannot escape `destDir`. If the source ever became untrusted, add an
// explicit member-path guard before relying on `tar`'s defaults.
async function realExtractTarball(tarball: Uint8Array, destDir: string): Promise<void> {
  const archive = join(tmpdir(), `tanren-fly-src-${process.pid}-${Date.now()}.tar.gz`);
  await writeFile(archive, tarball);
  try {
    await execFileAsync("tar", ["-xzf", archive, "-C", destDir, "--strip-components=1"], {
      maxBuffer: 32 * 1024 * 1024,
    });
  } finally {
    await rm(archive, { force: true }).catch(() => {});
  }
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

// Describe an unknown error value as a string for the cause field.
function describe(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

// Strip BOTH secrets (the Fly registry token + the GitHub installation token) from a cause
// string so a thrown `FlyImageBuildFailedError` can NEVER carry one — belt-and-suspenders on
// top of the script's stdin-only discipline (the Fly token never reaches stdout/stderr) and
// the `Authorization`-header-only GitHub token. No reachable path stringifies either into a
// cause today; redacting both here keeps that true if a future error path ever changes.
function sanitizeCause(cause: string, flyToken: string, sourceToken?: string): string {
  let out = flyToken === "" ? cause : cause.split(flyToken).join("[redacted]");
  if (sourceToken !== undefined && sourceToken !== "") {
    out = out.split(sourceToken).join("[redacted]");
  }
  return out;
}
