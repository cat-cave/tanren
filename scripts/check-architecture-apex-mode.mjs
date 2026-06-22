// no-apex-mode-branching (project-config-is-the-source-of-truth, BINDING): Tanren MUST
// NOT branch on whether it's running for apex. The `apex` fixture is the live-validation
// vehicle (a non-technical operator drives Tanren over the HTTP API), so the codebase
// must forget apex exists — the autonomy knobs (audit posture, CI-intelligence
// thresholds, notification readiness) are governed SETTINGS on the project config jsonb,
// configured via the same governance API any operator uses. An apex-mode branch makes
// apex test an apex-flavored variant instead of the real product.
//
// What it flags in **/src/** non-test files:
//   - `TANREN_APEX_MODE`           — the eradicated env var.
//   - `isApexMode`                 — the deleted helper.
//   - `APEX_MODE` (any casing)     — any sibling/synonym (catches a reintroduction).
//   - `APEX_THRESHOLDS`            — the deleted apex-overrides constant.
//   - `resolveDefaultAuditPosture` — the deleted apex-aware default-resolver.
//   - `resolveInsightThresholds`   — the deleted apex-aware default-resolver.
//
// Same per-line bless mechanism as check-architecture-timeouts.mjs (`// arch-allow:
// apex-mode <reason>`). A flagged line carrying the annotation is exempt — each exemption
// is reviewable in-source.
//
// ENFORCED: folded into `runArchitectureChecks` (the exit-1 set), so a NEWLY-introduced
// apex-mode branch FAILS `just ci`'s `check:architecture`.

function diagnostic(rule, file, message, line = 1) {
  return { rule, file, line, message };
}

const RULE = "no-apex-mode-branching";

// The per-line bless annotation. A flagged line is exempt iff it carries this marker.
const ARCH_ALLOW = "arch-allow: apex-mode";

// The banned tokens. Each pattern matches a WHOLE-WORD identifier (so an unrelated
// substring is not a false positive). The pattern carries its own message tail.
const bannedTokenPatterns = [
  {
    pattern: /\bTANREN_APEX_MODE\b/gu,
    detail: "the `TANREN_APEX_MODE` env var was eradicated — configure the equivalent via the project governance API",
  },
  {
    pattern: /\bisApexMode\b/gu,
    detail:
      "the `isApexMode()` helper was deleted — branch on the per-project governance config, not a process-wide apex toggle",
  },
  {
    pattern: /\bAPEX_THRESHOLDS\b/gu,
    detail:
      "`APEX_THRESHOLDS` was deleted — a project sets its own `insightThresholds` (e.g. `{ ciInsightFlakyMinShas: 1 }`) via the governance API",
  },
  {
    pattern: /\bresolveDefaultAuditPosture\b/gu,
    detail:
      "`resolveDefaultAuditPosture()` was deleted — the absent-config default is `DEFAULT_AUDIT_POSTURE`; a project sets `auditPosture: AUTONOMOUS_AUDIT_POSTURE` via the governance API",
  },
  {
    pattern: /\bresolveInsightThresholds\b/gu,
    detail:
      "`resolveInsightThresholds()` was deleted — layer `deps.thresholds` on top of `DEFAULT_THRESHOLDS`; a project sets `insightThresholds` via the governance API",
  },
  // Synonym/casing catcher — any IDENT named `*APEX_MODE*` or `*apexMode*` (the only
  // identifier-form `APEX_MODE` previously appeared in). Excludes the literal banned
  // identifier so we don't double-count (the named pattern above already flagged it).
  {
    pattern: /\b(?!TANREN_APEX_MODE\b)[A-Za-z_$][A-Za-z0-9_$]*[Aa]pex[_]?[Mm]ode[A-Za-z0-9_$]*\b/gu,
    detail: "an apex-mode-shaped identifier — Tanren must not branch on whether it's running for apex",
  },
];

function isProductionSource(file) {
  return file.includes("/src/") && !file.includes("/tests/") && !/\.test\.[tj]sx?$/u.test(file);
}

// Strip `//` line comments and `*`-prefixed block-comment bodies so a banned word in
// prose/JSDoc (this file's own header, a design comment) is never mistaken for code. The
// per-line `arch-allow: apex-mode` decision reads the RAW line.
function stripCommentary(line) {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
    return "";
  }
  const commentIndex = line.indexOf("//");
  return commentIndex === -1 ? line : line.slice(0, commentIndex);
}

// Collect every apex-mode-branching violation in one production-source line.
function violationsInLine(code) {
  const seen = new Map();
  for (const { pattern, detail } of bannedTokenPatterns) {
    for (const match of code.matchAll(pattern)) {
      const id = match[0];
      // Dedupe by the matched identifier so two patterns hitting the same token report once.
      if (!seen.has(id)) seen.set(id, detail);
    }
  }
  return [...seen.values()];
}

// The scanner. Returns one diagnostic per (line, violation). A line carrying the
// `// arch-allow: apex-mode …` annotation is exempt — the annotation must justify why
// the construct is a legitimate non-branching reference (a comment about why the var was
// removed, the lint script itself referencing the banned names, etc.).
export function checkNoApexModeBranching(projectFiles) {
  const diagnostics = [];
  for (const { file, text } of projectFiles) {
    if (!isProductionSource(file)) {
      continue;
    }
    const lines = text.split("\n");
    for (const [index, rawLine] of lines.entries()) {
      if (rawLine.includes(ARCH_ALLOW)) {
        continue;
      }
      const code = stripCommentary(rawLine);
      for (const detail of violationsInLine(code)) {
        diagnostics.push(diagnostic(RULE, file, detail, index + 1));
      }
    }
  }
  return diagnostics;
}
