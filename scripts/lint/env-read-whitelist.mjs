// env-read-whitelist — fail the build if ANY shipped `process.env.X` read is not
// deliberately governed. Two complementary gates (Codex r4 §4 widening):
//
//   • a `TANREN_*` read must live in a whitelisted FILE (`ENV_READ_FILE_WHITELIST`)
//     — the boot-time Zod `envSchema.ts` or a documented point-of-use boot module;
//   • a NON-`TANREN_` read (DATABASE_URL, the kill-switch flags, …) must name a var
//     in `NON_TANREN_ENV_ALLOWLIST`, each carrying a one-line rationale.
//
// Doctrine (boot-time env schema + no-silent-fallback): platform env is parsed
// ONCE, at boot, by the per-service Zod `envSchema.ts` (fail-loud on a malformed
// value). The PRIOR regex only matched `TANREN_*`, so a non-`TANREN_` read
// (`MERGE_AUTHORITY_LIVE`, `DATABASE_URL`, …) bypassed the gate entirely. The
// widened scan now governs EVERY literal-named env read.
//
// Adding a new env read is a DELIBERATE act: fold a `TANREN_*` knob into the
// service's `envSchema.ts` (preferred) or whitelist its file; for a non-`TANREN_`
// var, add it to `NON_TANREN_ENV_ALLOWLIST` with a rationale.
//
// Scope: shipped `*.ts`/`*.tsx` under services/ · db/ · cli/. Tests, scripts, and
// e2e are tooling (not the boot path) and are excluded wholesale. Matched reads:
// LITERAL-named `process.env.X` AND the project's `env("X")` indirection helper
// (Codex r5 §4 — the helper was a hole; the reaper's reads bypassed the bare-
// `process.env` scan through it). A fully-dynamic `env(name)` / `process.env[name]`
// (name a variable) carries no static name, so a `env(name)` helper call is required
// to live in an already-whitelisted FILE; a dynamic `process.env[name]` is left
// ungoverned (no helper home to anchor it).

import { glob, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { exit } from "node:process";

// Any literal-named read: `process.env["FOO"]` / `process.env['FOO']` /
// `process.env.FOO`. Capture group 1 (bracket form) or 2 (dot form) is the var name.
const ENV_READ = /process\.env\s*(?:\[\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s*\]|\.\s*([A-Za-z_][A-Za-z0-9_]*))/gu;

// The project's `env("LITERAL")` indirection HELPER — a local `function env(name)`
// wrapping `process.env[name]` (used in buildAllocator + the reaper). A literal-arg
// call (`env("TANREN_FOO")` / `env('TANREN_FOO')`) is a real env read that MUST be
// governed identically to a bare `process.env.X`, else the helper is a hole in the
// gate (Codex r5 §4: the reaper's reads bypassed the scan through exactly this
// indirection). `env` must be a STANDALONE call — preceded by a non-identifier,
// non-`.` char (so `process.env(` / `someObj.env(` / `parseEnv(` never match) and
// the arg a single string LITERAL. A fully-dynamic `env(variableName)` carries no
// static name; it is handled separately (see DYNAMIC_ENV_HELPER below).
const ENV_HELPER_READ = /(?<![.\w])env\(\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s*\)/gu;

// A DYNAMIC `env(name)` helper call — the arg is NOT a string literal (a variable /
// expression), so no static var name can be resolved. Such a call must live in an
// already-whitelisted file (the helper's home is a governed boot module); a NEW one
// in an un-whitelisted file is flagged for review. Matches `env(` followed by
// something other than a string literal (a `)` immediate-close `env()` is not a read).
const DYNAMIC_ENV_HELPER = /(?<![.\w])env\(\s*(?!["'`]|\))/gu;

// Non-`TANREN_` env vars the SHIPPED boot path is allowed to read directly, each
// with a one-line rationale. A NEW unlisted non-`TANREN_` read fails the build.
const NON_TANREN_ENV_ALLOWLIST = new Map([
  // ── connection strings (resolved at boot, loud-at-use / required) ───────────
  ["DATABASE_URL", "runtime DB connection string (db/client default + allocator app pool)"],
  ["MIGRATION_DATABASE_URL", "migrations-owner DB URL (loud-required at the migrate call site)"],
  // ── secret-store root credentials (file-preferred via *_FILE; Codex r4 §3) ──
  ["VAULT_TOKEN", "broad Vault token (file-preferred via VAULT_TOKEN_FILE)"],
  ["VAULT_TOKEN_FILE", "mounted Vault-token secret-file path (preferred over plaintext env)"],
  ["TANREN_GCP_SM_ACCESS_TOKEN_FILE", "mounted GCP-SM access-token secret-file path"],
  ["TANREN_AWS_SM_SECRET_ACCESS_KEY_FILE", "mounted AWS-SM secret-key secret-file path"],
  ["TANREN_OP_CONNECT_TOKEN_FILE", "mounted 1Password-Connect-token secret-file path"],
  // ── process / runtime ───────────────────────────────────────────────────────
  ["NODE_ENV", "dev/prod mode discriminator"],
  ["VITEST", "unit-test-runner discriminator — disables the live model-price fetch so fast-check stays offline"],
  ["npm_package_version", "service /healthz version stamp (npm-injected)"],
  ["ORCHESTRATOR_URL", "dashboard → orchestrator base URL (documented default)"],
  ["DASHBOARD_PORT", "dashboard HTTP listen port (documented default)"],
  [
    "PORT",
    "composed scaffold HTTP listen port (Fly injects PORT == fly.toml internal_port; template literal in runtime-node-pnpm.ts, not an orchestrator boot-path read)",
  ],
]);

// Files allowed to read `TANREN_*` directly. The envSchema files are the intended
// home; the rest are documented boot/config modules that resolve a single
// point-of-use knob (mostly required-secret / cert-path / feature-flag reads that
// are loud-at-use, or per-request config the schema does not own). Governs ONLY
// `TANREN_*` reads; non-`TANREN_` reads are governed per-VAR above.
const ENV_READ_FILE_WHITELIST = new Set([
  // ── the boot-time schemas (the intended home for env reads) ────────────────
  "services/orchestrator/src/envSchema.ts",
  "services/allocator/src/envSchema.ts",
  "services/dashboard/src/envSchema.ts",
  // ── orchestrator boot / point-of-use config modules ────────────────────────
  // main.ts: migrations owner URL + the runner-identity key material seeder
  // (required-at-use, loud, file/key reads — not numeric/bool knobs).
  "services/orchestrator/src/main.ts",
  // OIDC IdP env (issuer/client/claims/scopes) — additive, opt-in provider config.
  "services/orchestrator/src/auth/oidcEnv.ts",
  // Allocator boot: the allocator-kind + cloud-provider host/port/region/image
  // knobs + the loud `parseSshPort` / `resolveBootedAllocatorKind` parsers — all
  // read through the local `env("TANREN_*")` helper (now governed by the widened
  // ENV_HELPER_READ scan, so this file is whitelisted like any other boot module).
  "services/orchestrator/src/engine/allocators/buildAllocator.ts",
  // GitHub App install route: install URL + credential ref gate the mount.
  "services/orchestrator/src/routes/auth/githubAppInstall.ts",
  "services/orchestrator/src/mountFeatureRoutes.ts",
  // Worker boot + data-plane config (claim endpoint, mTLS certs, remote-writes
  // flag, run-worker flag, allocator kind, identity-key seeder).
  "services/orchestrator/src/engine/worker/boot.ts",
  // Runner SSH identity FromEnv: the secret REF (validated via the schema) + the
  // mounted-key-FILE seeder (TANREN_RUNNER_IDENTITY_KEY_PATH).
  "services/orchestrator/src/engine/worker/runnerIdentityFromEnv.ts",
  "services/orchestrator/src/engine/worker/lifecycle.ts",
  "services/orchestrator/src/engine/worker/claimClientFromEnv.ts",
  "services/orchestrator/src/engine/worker/runStateWriterFromEnv.ts",
  "services/orchestrator/src/engine/worker/buildRunWorkspaceReaper.ts",
  // Notification default channel/destination/severity + ntfy base URL.
  "services/orchestrator/src/engine/notifications/build.ts",
  "services/orchestrator/src/engine/notifications/channels/ntfy.ts",
  // JIT env-image creation boot config (env-management.md §7 P4): the env registry +
  // image name + push posture + build/validate timeouts + the build-script path —
  // read once at worker boot to build the EnvCreationDeps (gated on TANREN_ENV_REGISTRY).
  "services/orchestrator/src/engine/environments/creation/envCreationConfig.ts",
  // Live Fly image-builder boot config (PR3): the opt-in flag
  // (TANREN_FLY_IMAGE_BUILDER) + the App credential ref (TANREN_GITHUB_APP_CREDENTIAL_REF,
  // to sign repo→installation JWTs) + the build-script path — read once at boot to
  // construct the merge-reflecting FlyImageBuilder (gated on the opt-in flag). The
  // deploy-layer counterpart of envCreationConfig.ts above.
  "services/orchestrator/src/engine/provisioners/flyImageBuilderConfig.ts",
  // ds-4 Slice B render-worker point-of-use config: the podman binary name
  // (TANREN_PODMAN_BIN) + the render-worker image ref (TANREN_DS4_RENDER_IMAGE) —
  // both non-secret, defaulted knobs read when the containerized screenshot runner
  // is constructed (same point-of-use posture as the env/Fly build config above).
  "services/orchestrator/src/engine/design/render/podmanScreenshotRunner.ts",
  // rv-26.6 browser click runner point-of-use config: the SAME non-secret
  // defaulted knobs (TANREN_PODMAN_BIN + TANREN_DS4_RENDER_IMAGE) read when the
  // containerized click runner is constructed — same posture as the screenshot runner.
  "services/orchestrator/src/engine/verification/acceptance/podmanBrowserClickRunner.ts",
  // ── allocator boot ─────────────────────────────────────────────────────────
  // main.ts: the BYPASSRLS system DB URL pool selection.
  "services/allocator/src/main.ts",
  // The per-run runner container's authorized-key env passthrough.
  "services/allocator/src/runnerLifecycle.ts",
  // requireRunnerAuthorizedKey.ts: fail-closed authorized-key reader (extracted from runnerLifecycle).
  "services/allocator/src/requireRunnerAuthorizedKey.ts",
  // ── dashboard config ───────────────────────────────────────────────────────
  // Boot knobs (ORCHESTRATOR_URL / REQUIRE_AUTH / DEV_LOGIN / port / profile)
  // live in envSchema.ts above. session.ts re-resolves dev-login via
  // resolveDevLoginEnabled(process.env) — that helper owns the read. Onboarding
  // still carries canonical-named URL fallbacks (preferred source is the
  // orchestrator's /auth/providers).
  "services/dashboard/src/routes/onboarding/index.tsx",
  "services/dashboard/src/routes/onboarding/existing/index.tsx",
  // ── cli config ─────────────────────────────────────────────────────────────
  "cli/src/httpClient.ts",
  "cli/src/main.ts",
  "cli/src/auth/store.ts",
  // ── structured logger seams ────────────────────────────────────────────────
  // TANREN_LOG_LEVEL: the per-call level FILTER for the structured logger (a
  // loud-at-use, default-`info` runtime knob, NOT boot config — it is read lazily
  // per log call so the level can change without a redeploy). Each service has its
  // own dependency-free logger module (the allocator/dashboard are separate pkgs).
  "services/orchestrator/src/engine/observability/logger.ts",
  "services/allocator/src/logger.ts",
  "services/dashboard/src/serverLogger.ts",
  // ── live model-price cache knobs ───────────────────────────────────────────
  // TANREN_MODEL_PRICE_TTL_SECONDS (live-refresh interval, default 1h) +
  // TANREN_MODEL_PRICE_LIVE (=0 kill switch → freeze to the vendored seed): both
  // loud-at-use, defaulted RUNTIME knobs read lazily when the live price source
  // singleton is first built (same posture as TANREN_LOG_LEVEL above), NOT boot
  // config the Zod schema owns.
  "services/orchestrator/src/engine/costs/pricing/modelPriceSource.ts",
  // ── db ─────────────────────────────────────────────────────────────────────
  // The system (BYPASSRLS) DB URL the org-scope seam reads.
  "db/src/orgScope.ts",
]);

// ── VARIABLE-AWARE secret gate (Codex r6 §3) ────────────────────────────────
// A file-level whitelist is NOT enough for a secret VALUE: once a boot file is
// whitelisted, the prior gate let it read ANY `TANREN_*` — including the secret
// VALUE `TANREN_OIDC_CLIENT_SECRET`. The gate is now VARIABLE-AWARE: a direct read
// of a SECRET-SHAPED var (a `*_SECRET` / `*_TOKEN` — but NOT a `*_TOKEN_FILE` /
// `*_TOKEN_REF` indirection — / `*_PRIVATE_KEY`) is FORBIDDEN even in a whitelisted
// file. A secret value must instead be resolved through a FILE-PREFERRED helper
// (`requireSecretFromFileOrEnv` / `optionalSecretFromFileOrEnv` / `requireVaultToken`),
// which reads the var by name as a helper ARGUMENT (not a `process.env` literal),
// so the scan never sees it — the file-mount path wins, the plaintext env is only a
// dev convenience. The ONLY exceptions are vars EXPLICITLY classified below as
// non-secret (a public key, a ref handle, or a path).

// A var name shaped like a SECRET VALUE: `*_SECRET` / `*_TOKEN` / a `*_KEY`
// (private-key material). The INDIRECTIONS are excluded — `*_TOKEN_FILE` /
// `*_TOKEN_REF` (a mount path / store handle) and the `*_KEY_PATH` / `*_KEY_FILE` /
// `*_KEY_REF` / `*_KEY_NAME` config forms (a path / handle / identifier, not the key
// bytes). A secret-shaped name that is NOT one of those indirections is forbidden as
// a direct read UNLESS explicitly classified below.
function isSecretShapedVar(name) {
  if (/(?:_TOKEN_FILE|_TOKEN_REF|_KEY_PATH|_KEY_FILE|_KEY_REF|_KEY_NAME)$/u.test(name)) {
    return false;
  }
  return /(?:_SECRET|_TOKEN|_KEY)$/u.test(name);
}

// EXPLICIT non-secret classification for a secret-SHAPED name that is provably NOT
// a secret value: `public` (public key material), `ref` (an opaque store handle —
// the value lives in the secret store, not here), or `path` (a filesystem path to a
// mounted secret, not the secret itself). A classified var may be read directly even
// though its name matches the secret shape. EVERYTHING ELSE secret-shaped is FORBIDDEN
// as a direct read and must go through a file-preferred helper.
const SECRET_VAR_CLASSIFICATION = new Map([
  // The runner's AUTHORIZED public key (the `authorized_keys` line) — public key
  // material, not a private secret; safe to read directly.
  ["TANREN_RUNNER_AUTHORIZED_KEY", "public"],
  // Cloud SSH PUBLIC keys handed to the provider so the runner accepts our identity —
  // public key material (the matching PRIVATE key is the runner SSH identity, read
  // off a different seam at connect time, never here).
  ["TANREN_GCP_SSH_PUBLIC_KEY", "public"],
  ["TANREN_K8S_SSH_PUBLIC_KEY", "public"],
  // The cloud key-pair NAME (an identifier the provider resolves to a stored key) —
  // a handle, not key bytes. (`*_KEY_NAME` is also excluded by shape; classified for
  // explicitness.)
  ["TANREN_AWS_KEY_NAME", "ref"],
  // The data-plane mTLS private-key FILESYSTEM PATH (not the key bytes); the bytes
  // are read from the mounted file, never carried in env.
  ["TANREN_DATA_PLANE_TLS_KEY", "path"],
]);

// The file-preferred secret helpers. A secret VALUE must be resolved through one of
// these (which name the var as an ARGUMENT, so it never appears as a `process.env`
// literal the scan can see). Listed for documentation + to anchor the doctrine; the
// scan enforces the inverse (a DIRECT secret-shaped read is the violation).
const FILE_PREFERRED_SECRET_HELPERS = new Set([
  "requireSecretFromFileOrEnv",
  "optionalSecretFromFileOrEnv",
  "requireVaultToken",
]);
void FILE_PREFERRED_SECRET_HELPERS;

const SCAN_GLOBS = ["services/**/*.{ts,tsx}", "db/**/*.{ts,tsx}", "cli/**/*.{ts,tsx}"];
const IGNORED_SEGMENTS = new Set(["node_modules", "dist", "coverage", ".turbo", ".claude"]);

function normalize(path) {
  return path.split("\\").join("/");
}

function isExcluded(file) {
  const parts = file.split("/");
  if (parts.some((part) => IGNORED_SEGMENTS.has(part))) {
    return true;
  }
  // Tests / e2e / build-tooling configs are tooling, not the shipped boot path.
  return (
    parts.includes("tests") ||
    parts.includes("test") ||
    parts.includes("e2e") ||
    file.endsWith(".test.ts") ||
    file.endsWith(".test.tsx") ||
    file.endsWith(".spec.ts") ||
    file.endsWith(".spec.tsx") ||
    file.endsWith(".config.ts") ||
    file.endsWith(".config.tsx")
  );
}

function lineFor(text, index) {
  return text.slice(0, index).split("\n").length;
}

// Blank out `//` line comments and `/* … */` block comments, REPLACING each
// stripped char with a space (newlines preserved) so byte offsets — and thus
// `lineFor` line numbers — stay exact. This stops a DOCTRINE COMMENT that mentions
// a literal `process.env.FOO` (e.g. config/shared.ts's "never `process.env.X ??
// default`") from registering as a real read. Simple char-scan, not a full JS
// lexer — good enough for the shipped source (no `process.env` inside string
// literals here), and conservative (only blanks comments).
function stripComments(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      while (i < n && text[i] !== "\n") {
        out += " ";
        i += 1;
      }
    } else if (ch === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) {
        out += text[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      if (i < n) {
        out += "  ";
        i += 2;
      }
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

async function collect(root) {
  const files = new Set();
  for (const pattern of SCAN_GLOBS) {
    for await (const entry of glob(pattern, { cwd: root })) {
      const file = normalize(entry);
      if (!isExcluded(file)) {
        files.add(file);
      }
    }
  }
  return [...files].toSorted();
}

export async function runEnvReadWhitelistCheck({ root = process.cwd() } = {}) {
  const resolvedRoot = resolve(root);
  const files = await collect(resolvedRoot);
  const violations = [];
  for (const file of files) {
    const text = stripComments(await readFile(resolve(resolvedRoot, file), "utf8"));
    // A literal-named read is governed the SAME way whether it is a bare
    // `process.env.X` OR a `env("X")` helper call: a `TANREN_*` name must live in a
    // whitelisted FILE; a non-`TANREN_` name must be an allowlisted VAR.
    for (const re of [ENV_READ, ENV_HELPER_READ]) {
      for (const match of text.matchAll(re)) {
        const name = match[1] ?? match[2];
        // VARIABLE-AWARE secret gate (r6 §3): a DIRECT read of a secret-VALUE-shaped
        // var is forbidden EVEN IN A WHITELISTED FILE unless it is explicitly
        // classified non-secret (public/ref/path). The fix is to route it through a
        // file-preferred helper (which reads the name as an argument, invisible here).
        if (isSecretShapedVar(name) && !SECRET_VAR_CLASSIFICATION.has(name)) {
          violations.push({ file, line: lineFor(text, match.index), snippet: match[0], reason: "secret-direct-read" });
          continue;
        }
        if (name.startsWith("TANREN_")) {
          // A `TANREN_*` read must live in a whitelisted boot/config FILE.
          if (!ENV_READ_FILE_WHITELIST.has(file)) {
            violations.push({ file, line: lineFor(text, match.index), snippet: match[0], reason: "tanren-file" });
          }
        } else if (!NON_TANREN_ENV_ALLOWLIST.has(name)) {
          // A non-`TANREN_` read must name an allowlisted var (per-var rationale).
          violations.push({ file, line: lineFor(text, match.index), snippet: match[0], reason: "non-tanren-var" });
        }
      }
    }
    // A DYNAMIC `env(name)` helper call (no static name) can't be name-governed, so
    // it must at least live in a whitelisted boot/config FILE — the helper's home.
    if (!ENV_READ_FILE_WHITELIST.has(file)) {
      for (const match of text.matchAll(DYNAMIC_ENV_HELPER)) {
        violations.push({
          file,
          line: lineFor(text, match.index),
          snippet: `${match[0]}…)`,
          reason: "dynamic-env-file",
        });
      }
    }
  }
  return violations;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const violations = await runEnvReadWhitelistCheck();
  if (violations.length > 0) {
    console.error("env-read-whitelist: a process.env read is not governed.");
    console.error(
      "Fold a TANREN_* read into the service's envSchema.ts (or whitelist its file in ENV_READ_FILE_WHITELIST); " +
        "add a non-TANREN_ var to NON_TANREN_ENV_ALLOWLIST with a one-line rationale. A `secret-direct-read` " +
        "(a *_SECRET / *_TOKEN / *_PRIVATE_KEY value) must instead go through a file-preferred helper " +
        "(requireSecretFromFileOrEnv / optionalSecretFromFileOrEnv / requireVaultToken), or be classified " +
        "non-secret in SECRET_VAR_CLASSIFICATION (public/ref/path).\n",
    );
    for (const violation of violations) {
      console.error(`${relative(process.cwd(), resolve(violation.file))}:${violation.line}: ${violation.snippet}`);
    }
    exit(1);
  }
  console.log("env-read-whitelist passed");
}
