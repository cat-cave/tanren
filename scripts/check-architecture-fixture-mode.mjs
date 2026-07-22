// cspell:ignore ixture
// no-fixture-mode-branching (project-config-is-the-source-of-truth, BINDING): Tanren
// MUST NOT branch on a validation fixture. The autonomy knobs (audit posture,
// CI-intelligence thresholds, notification readiness) are governed settings on the
// project config jsonb, configured through the same governance API any operator uses.
// A fixture-only branch would test a product variant rather than the normal product.
//
// What it flags in **/src/** non-test files:
//   - `TANREN_FIXTURE_MODE`        — an eradicated process-wide fixture toggle.
//   - `isFixtureMode`              — a fixture-only helper.
//   - `FIXTURE_MODE` (any casing)  — any sibling/synonym (catches a reintroduction).
//   - `FIXTURE_THRESHOLDS`         — a fixture-only overrides constant.
//   - `resolveDefaultAuditPosture` — a fixture-aware default-resolver.
//   - `resolveInsightThresholds`   — a fixture-aware default-resolver.
//
// Same per-line bless mechanism as check-architecture-timeouts.mjs (`// arch-allow:
// fixture-mode <reason>`). A flagged line carrying the annotation is exempt — each exemption
// is reviewable in-source.
//
// ENFORCED: folded into `runArchitectureChecks` (the exit-1 set), so a NEWLY-introduced
// fixture-mode branch fails `just ci`'s `check:architecture`.

function diagnostic(rule, file, message, line = 1) {
  return { rule, file, line, message };
}

const RULE = "no-fixture-mode-branching";

// The per-line bless annotation. A flagged line is exempt iff it carries this marker.
const ARCH_ALLOW = "arch-allow: fixture-mode";

// The banned tokens. Each pattern matches a WHOLE-WORD identifier (so an unrelated
// substring is not a false positive). The pattern carries its own message tail.
const bannedTokenPatterns = [
  {
    pattern: /\bTANREN_FIXTURE_MODE\b/gu,
    detail:
      "the `TANREN_FIXTURE_MODE` env var was eradicated — configure the equivalent via the project governance API",
  },
  {
    pattern: /\bisFixtureMode\b/gu,
    detail:
      "the `isFixtureMode()` helper was eradicated — branch on the per-project governance config, not a process-wide fixture toggle",
  },
  {
    pattern: /\bFIXTURE_THRESHOLDS\b/gu,
    detail:
      "`FIXTURE_THRESHOLDS` was eradicated — a project sets its own `insightThresholds` (e.g. `{ ciInsightFlakyMinShas: 1 }`) via the governance API",
  },
  {
    pattern: /\bresolveDefaultAuditPosture\b/gu,
    detail:
      "`resolveDefaultAuditPosture()` is fixture-aware branching — the absent-config default is `DEFAULT_AUDIT_POSTURE`; a project sets `auditPosture: AUTONOMOUS_AUDIT_POSTURE` via the governance API",
  },
  {
    pattern: /\bresolveInsightThresholds\b/gu,
    detail:
      "`resolveInsightThresholds()` is fixture-aware branching — layer `deps.thresholds` on top of `DEFAULT_THRESHOLDS`; a project sets `insightThresholds` via the governance API",
  },
  // Synonym/casing catcher — any IDENT named `*FIXTURE_MODE*` or `*fixtureMode*`.
  // Excludes the literal banned
  // identifier so we don't double-count (the named pattern above already flagged it).
  {
    pattern: /\b(?!TANREN_FIXTURE_MODE\b)[A-Za-z_$][A-Za-z0-9_$]*[Ff]ixture[_]?[Mm]ode[A-Za-z0-9_$]*\b/gu,
    detail: "a fixture-mode-shaped identifier — Tanren must not branch on a validation fixture",
  },
];

function isProductionSource(file) {
  return file.includes("/src/") && !file.includes("/tests/") && !/\.test\.[tj]sx?$/u.test(file);
}

// Strip `//` line comments and `*`-prefixed block-comment bodies so a banned word in
// prose/JSDoc (this file's own header, a design comment) is never mistaken for code. The
// per-line `arch-allow: fixture-mode` decision reads the raw line.
function stripCommentary(line) {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
    return "";
  }
  const commentIndex = line.indexOf("//");
  return commentIndex === -1 ? line : line.slice(0, commentIndex);
}

// Collect every fixture-mode-branching violation in one production-source line.
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
// `// arch-allow: fixture-mode …` annotation is exempt — the annotation must justify why
// the construct is a legitimate non-branching reference (a comment about why the var was
// removed, the lint script itself referencing the banned names, etc.).
export function checkNoFixtureModeBranching(projectFiles) {
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
