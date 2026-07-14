// Live Fly image-builder BOOT WIRING (PR3) — the config surface that constructs the
// live `FlyImageBuilder` from env + deps, mirroring `envCreationConfig.ts` (the env-side
// JIT-build wiring). Reads the env knobs in ONE place (no scattered `process.env`) and
// assembles the injected deps the live driver (`liveFlyImageBuilder.ts`) runs over.
//
// NO-SILENT-FALLBACK DOCTRINE (like `JitBuildRequiredError`): the builder is OFF unless
// `TANREN_FLY_IMAGE_BUILDER=1` opts in. When opted IN, a missing construction dep (no App
// minter, no App credential ref) THROWS `FlyImageBuilderConfigError` LOUD — never a silent
// `undefined` that would make a Fly deploy degrade to the static-image path (the operator
// asked for merge-reflecting deploys; a missing dep is a config error, not an off switch).
// When opted OUT, `undefined` is the legitimate off state and `triggerDeploy` fails loud
// per-provider (no builder + `TANREN_ALLOW_FLY_STATIC_DEPLOY=0` → throw).
//
// The `mintSourceToken` dep is wired over the shared `GithubAppTokenMinter`: for a repo
// it resolves the App's installation (`GET /repos/{owner}/{repo}/installation` with an App
// JWT) then mints an installation token — the bearer for the tarball fetch. The App JWT +
// installation token NEVER leave the `Authorization` header (never logged/returned).

import { resolve } from "node:path";
import type { SecretStore } from "../contracts/secretStore.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import { signAppJwt } from "../providers/githubAppTokenMinter.js";
import { loadGithubAppCredential, type GithubAppCredential } from "../credentials/githubApp.js";
import {
  buildLiveFlyImageBuilder,
  type LiveFlyImageBuilderDeps,
  realFlyImageBuilderSideEffects,
} from "./liveFlyImageBuilder.js";
import type { FlyImageBuilder } from "./flyImageBuilder.js";

/**
 * Thrown when the live Fly image-builder is opted in (`TANREN_FLY_IMAGE_BUILDER=1`) but a
 * required construction dep is missing — a LOUD config error (never a silent degrade to
 * `undefined`, which would make a Fly deploy fall to the non-merge-reflecting static-image
 * path). Mirrors `JitBuildRequiredError`'s "halt loud" doctrine.
 */
export class FlyImageBuilderConfigError extends Error {
  constructor(reason: string) {
    super(
      `TANREN_FLY_IMAGE_BUILDER is set but the live builder cannot be constructed: ${reason}. ` +
        `Either provide the missing dep or unset TANREN_FLY_IMAGE_BUILDER. A Fly deploy with ` +
        `no builder fails loud at trigger time (set TANREN_ALLOW_FLY_STATIC_DEPLOY=1 to ` +
        `explicitly accept the non-merge-reflecting static-image semantics).`,
    );
    this.name = "FlyImageBuilderConfigError";
  }
}

/** The shared deps the boot supplies so the config reader can construct the builder. */
export interface BuildFlyImageBuilderInput {
  /** The shared App-token minter (its cache lives here). Required to mint source tokens. */
  githubAppMinter?: GithubAppTokenMinter;
  /** The secret store (loads the App credential that signs the repo→installation JWT). */
  secrets: SecretStore;
}

// Resolve the build script path relative to THIS module — it lives at the repo's
// scripts/dev/build-deploy-image.sh. The orchestrator src tree is
// services/orchestrator/src/engine/provisioners; the repo root is five levels up.
// Deterministic so the wiring needs no env var for the script path.
function defaultScriptPath(): string {
  return resolve(import.meta.dirname, "../../../../../scripts/dev/build-deploy-image.sh");
}

/**
 * Is the live Fly image-builder opted in? Opt-in ONLY on the canonical truthy tokens
 * (`1`/`true`/`yes`/`on`) — NOT any-non-empty. Otherwise a compose default of `"0"` (or
 * `"false"`) reads as ON and the worker fail-loud-crashes at boot when the cred ref is
 * unset — a real trap, since `"0"` universally means OFF. Empty/unset/`0`/`false` → off.
 */
export function flyImageBuilderConfigured(): boolean {
  const value = process.env["TANREN_FLY_IMAGE_BUILDER"]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

/**
 * Build the live `FlyImageBuilder` from the env config surface, or `undefined` when the
 * builder is not opted in (`TANREN_FLY_IMAGE_BUILDER` unset) — in which case a Fly deploy
 * fails loud at `triggerDeploy` (no builder + flag off → throw). When opted IN, a missing
 * construction dep throws {@link FlyImageBuilderConfigError} (no silent fallback).
 */
export function buildFlyImageBuilderFromEnv(input: BuildFlyImageBuilderInput): FlyImageBuilder | undefined {
  if (!flyImageBuilderConfigured()) {
    // Opted OUT → legitimate off state; triggerDeploy fail-loud per-provider handles Fly.
    return undefined;
  }
  if (input.githubAppMinter === undefined) {
    throw new FlyImageBuilderConfigError("no GitHub App token minter wired (the App is not configured)");
  }
  const credentialRef = process.env["TANREN_GITHUB_APP_CREDENTIAL_REF"]?.trim();
  if (credentialRef === undefined || credentialRef === "") {
    throw new FlyImageBuilderConfigError(
      "TANREN_GITHUB_APP_CREDENTIAL_REF is unset (required to sign repo→installation JWTs)",
    );
  }
  const scriptPath = process.env["TANREN_FLY_BUILD_SCRIPT"]?.trim() ?? defaultScriptPath();
  const mintSourceToken = buildGithubSourceTokenMinter({
    minter: input.githubAppMinter,
    credentialRef,
    secrets: input.secrets,
  });
  const deps: LiveFlyImageBuilderDeps = {
    scriptPath,
    mintSourceToken,
    ...realFlyImageBuilderSideEffects(),
  };
  return buildLiveFlyImageBuilder(deps);
}

/**
 * The production `mintSourceToken`: given a repo (`owner/name`), resolve the App's
 * installation id (`GET /repos/{owner}/{repo}/installation` with an App JWT) then mint an
 * installation token via the shared minter — the bearer the builder uses to fetch the
 * merged-commit tarball. The App credential (appId + private key) is loaded ONCE + cached;
 * the minter caches the installation token itself. The JWT + installation token travel
 * ONLY in `Authorization` headers — never logged, never returned, never in a URL.
 */
export function buildGithubSourceTokenMinter(args: {
  minter: GithubAppTokenMinter;
  credentialRef: string;
  secrets: SecretStore;
  fetchImpl?: typeof fetch;
  apiBaseUrl?: string;
  now?: () => number;
}): (repo: string) => Promise<string> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const apiBaseUrl = (args.apiBaseUrl ?? "https://api.github.com").replace(/\/$/u, "");
  const now = args.now ?? Date.now;
  let credentialPromise: Promise<GithubAppCredential> | undefined;
  const loadCredential = (): Promise<GithubAppCredential> => {
    if (credentialPromise === undefined) {
      credentialPromise = loadGithubAppCredential(args.secrets, args.credentialRef);
    }
    return credentialPromise;
  };
  return async (repo: string): Promise<string> => {
    const credential = await loadCredential();
    const jwt = signAppJwt(credential.appId, credential.privateKeyPem, Math.floor(now() / 1000));
    const response = await fetchImpl(`${apiBaseUrl}/repos/${repo}/installation`, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${jwt}` },
    });
    if (!response.ok) {
      throw new Error(`resolve GitHub installation for '${repo}' failed: HTTP ${response.status}`);
    }
    const body = (await response.json().catch(() => {})) as { id?: unknown } | undefined;
    if (body === undefined || typeof body.id !== "number") {
      throw new Error(`resolve GitHub installation for '${repo}' returned no installation id`);
    }
    const installationId = String(body.id);
    return args.minter.getInstallationToken({ installationId, credentialRef: args.credentialRef });
  };
}
