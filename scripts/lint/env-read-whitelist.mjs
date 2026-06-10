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
// e2e are tooling (not the boot path) and are excluded wholesale. Only LITERAL-named
// reads are matched — a dynamic `process.env[name]` (name passed as a variable, e.g.
// the secretStoreFactory `env[name]` indirection) carries no static name to govern.

import { glob, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { exit } from "node:process";

// Any literal-named read: `process.env["FOO"]` / `process.env['FOO']` /
// `process.env.FOO`. Capture group 1 (bracket form) or 2 (dot form) is the var name.
const ENV_READ = /process\.env\s*(?:\[\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s*\]|\.\s*([A-Za-z_][A-Za-z0-9_]*))/gu;

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
  ["npm_package_version", "service /healthz version stamp (npm-injected)"],
  ["ORCHESTRATOR_URL", "dashboard → orchestrator base URL (documented default)"],
  ["DASHBOARD_PORT", "dashboard HTTP listen port (documented default)"],
  // ── tanren-owns-the-engine kill-switch flags (documented post-apex §7) ──────
  ["MERGE_AUTHORITY_LIVE", "documented post-apex §7 kill-switch deletion"],
  ["CONFLICT_RESOLVER_JJ_LIVE", "documented post-apex §7 kill-switch deletion"],
  ["BASE_SHIFT_LIVE", "documented post-apex §7 kill-switch deletion"],
  ["INTEGRATION_NODES_DRIVE", "documented post-apex §7 kill-switch deletion"],
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
    for (const match of text.matchAll(ENV_READ)) {
      const name = match[1] ?? match[2];
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
  return violations;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const violations = await runEnvReadWhitelistCheck();
  if (violations.length > 0) {
    console.error("env-read-whitelist: a process.env read is not governed.");
    console.error(
      "Fold a TANREN_* read into the service's envSchema.ts (or whitelist its file in ENV_READ_FILE_WHITELIST); " +
        "add a non-TANREN_ var to NON_TANREN_ENV_ALLOWLIST with a one-line rationale.\n",
    );
    for (const violation of violations) {
      console.error(`${relative(process.cwd(), resolve(violation.file))}:${violation.line}: ${violation.snippet}`);
    }
    exit(1);
  }
  console.log("env-read-whitelist passed");
}
