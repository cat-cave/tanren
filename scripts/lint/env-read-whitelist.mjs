// env-read-whitelist — fail the build if a `TANREN_*` environment variable is
// read OUTSIDE the deliberate whitelist below.
//
// Doctrine (boot-time env schema + no-silent-fallback): platform env is parsed
// ONCE, at boot, by the per-service Zod `envSchema.ts` (fail-loud on a malformed
// value). To stop the schema from being bypassed by a new ad-hoc
// `process.env["TANREN_..."]` read sprinkled anywhere in the tree, this gate
// scans the SHIPPED source and rejects any `TANREN_*` read in a file that is not
// either an `envSchema.ts` or a documented boot/config module.
//
// Adding a new env read is a DELIBERATE act: either fold it into the service's
// `envSchema.ts` (preferred), or — for a genuine point-of-use boot/config module
// — add the file to `ENV_READ_WHITELIST` below with a one-line rationale.
//
// Scope: shipped `*.ts`/`*.tsx` under services/ · db/ · cli/. Tests, scripts, and
// e2e are tooling (not the boot path) and are excluded wholesale.

import { glob, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { exit } from "node:process";

// `process.env["TANREN_FOO"]` / `process.env['TANREN_FOO']` / `process.env.TANREN_FOO`.
const TANREN_ENV_READ = /process\.env\s*(?:\[\s*["'`]TANREN_[A-Z0-9_]+["'`]\s*\]|\.\s*TANREN_[A-Z0-9_]+)/gu;

// Files allowed to read `TANREN_*` directly. The envSchema files are the intended
// home; the rest are documented boot/config modules that resolve a single
// point-of-use knob (mostly required-secret / cert-path / feature-flag reads that
// are loud-at-use, or per-request config the schema does not own).
const ENV_READ_WHITELIST = new Set([
  // ── the boot-time schemas (the intended home for env reads) ────────────────
  "services/orchestrator/src/envSchema.ts",
  "services/allocator/src/envSchema.ts",
  // ── orchestrator boot / point-of-use config modules ────────────────────────
  // main.ts: migrations owner URL + the runner-identity key material seeder
  // (required-at-use, loud, file/key reads — not numeric/bool knobs).
  "services/orchestrator/src/main.ts",
  // OIDC IdP env (issuer/client/claims/scopes) — additive, opt-in provider config.
  "services/orchestrator/src/auth/oidcEnv.ts",
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
  // ── allocator boot ─────────────────────────────────────────────────────────
  // main.ts: the BYPASSRLS system DB URL pool selection.
  "services/allocator/src/main.ts",
  // The per-run runner container's authorized-key env passthrough.
  "services/allocator/src/runnerLifecycle.ts",
  // requireRunnerAuthorizedKey.ts: fail-closed authorized-key reader (extracted from runnerLifecycle).
  "services/allocator/src/requireRunnerAuthorizedKey.ts",
  // ── dashboard config ───────────────────────────────────────────────────────
  // Dev-login flag + require-auth gate; onboarding's canonical-named URL
  // fallbacks (preferred source is the orchestrator's /auth/providers).
  "services/dashboard/src/auth/session.ts",
  "services/dashboard/src/main.tsx",
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
  // ── db ─────────────────────────────────────────────────────────────────────
  // The system (BYPASSRLS) DB URL the org-scope seam reads.
  "db/src/orgScope.ts",
]);

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
  // Tests / e2e are tooling, not the boot path.
  return (
    parts.includes("tests") ||
    parts.includes("test") ||
    parts.includes("e2e") ||
    file.endsWith(".test.ts") ||
    file.endsWith(".test.tsx") ||
    file.endsWith(".spec.ts") ||
    file.endsWith(".spec.tsx")
  );
}

function lineFor(text, index) {
  return text.slice(0, index).split("\n").length;
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
    if (ENV_READ_WHITELIST.has(file)) {
      continue;
    }
    const text = await readFile(resolve(resolvedRoot, file), "utf8");
    for (const match of text.matchAll(TANREN_ENV_READ)) {
      violations.push({ file, line: lineFor(text, match.index), snippet: match[0] });
    }
  }
  return violations;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const violations = await runEnvReadWhitelistCheck();
  if (violations.length > 0) {
    console.error("env-read-whitelist: a TANREN_* env var is read outside the schema / whitelist.");
    console.error(
      "Fold the read into the service's envSchema.ts, or add the file to ENV_READ_WHITELIST with a rationale.\n",
    );
    for (const violation of violations) {
      console.error(`${relative(process.cwd(), resolve(violation.file))}:${violation.line}: ${violation.snippet}`);
    }
    exit(1);
  }
  console.log("env-read-whitelist passed");
}
