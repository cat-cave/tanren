// guard-rule-changes.mjs — reviewer-config change guard (DESIGN §SECURITY.4, issue #110)
//
// A PR must not be allowed to weaken its own reviewer. This script inspects the
// PR diff (base..head) and flags it if it touches any reviewer-config surface:
//   - ops/review/**            (rules, scripts, model routing, this guard)
//   - .opencodereview/**       (OCR's PR-head config dir — the RCE vector)
//   - .github/workflows/ocr-*  (the untrusted/trusted split workflows themselves)
//
// Output (both channels, so the workflow can gate and the artifact can record it):
//   - `rule_change=true|false` and `rule_change_paths=<csv>` appended to $GITHUB_OUTPUT
//   - a single JSON line on stdout: {"rule_change":bool,"matched":[...paths]}
//
// When rule_change=true the TRUSTED job posts a P0
// "reviewer-config change — maintainer review required" and sets verdict=FAIL.
//
// SECURITY: this file is executed from the TRUSTED BASE checkout, never from PR
// head — so a PR that edits this script cannot disable its own guard. Shas are
// sanitized and passed to git via execFileSync arg arrays (no shell, no option
// injection); a leading `-` is rejected so a PR-supplied ref can't smuggle a
// `--upload-pack`/`-O` style git option.

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

// Reviewer-config surfaces. Kept as simple prefix/pattern tests (no glob dep):
// every changed path is normalized to forward slashes and tested against these.
const GUARDED = [
  (p) => p.startsWith("ops/review/"),
  (p) => p.startsWith(".opencodereview/"),
  (p) => p.startsWith(".github/workflows/ocr-"),
];

const SHA_RE = /^[0-9a-f]{7,40}$/u;

/** Validate a commit sha before it ever reaches git. Reject empties, non-hex,
 *  and any leading `-` (git option injection). Throws loud on bad input. */
function sanitizeSha(label, raw) {
  const v = String(raw ?? "").trim();
  if (v.startsWith("-")) throw new Error(`${label}: refuses leading '-' (option injection): ${JSON.stringify(v)}`);
  if (!SHA_RE.test(v)) throw new Error(`${label}: not a valid sha (^[0-9a-f]{7,40}$): ${JSON.stringify(v)}`);
  return v;
}

/** Read a flag from argv (`--base <sha>`) with an env fallback. */
function arg(flag, envName) {
  const i = process.argv.indexOf(flag);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  return process.env[envName];
}

function main() {
  const base = sanitizeSha("base", arg("--base", "BASE_SHA"));
  const head = sanitizeSha("head", arg("--head", "HEAD_SHA"));

  // `--` terminates option parsing; the two shas are already sanitized to pure
  // hex, so they cannot be interpreted as flags. Two-dot range = changes on head
  // relative to the merge base is intentionally NOT used here; we want the exact
  // base..head file set the reviewer sees.
  let out = "";
  try {
    out = execFileSync("git", ["diff", "--name-only", "--no-color", `${base}..${head}`, "--"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    // Fail LOUD, not open: if we cannot compute the diff we cannot certify the
    // PR did not touch the reviewer config. Surface a non-zero exit.
    process.stderr.write(`guard-rule-changes: git diff failed: ${err?.message ?? err}\n`);
    process.exit(2);
  }

  const changed = out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => p.replaceAll("\\", "/"));
  const matched = changed.filter((p) => GUARDED.some((test) => test(p)));
  const ruleChange = matched.length > 0;

  // Machine-readable stdout line (consumed when assembling review-output.json).
  process.stdout.write(`${JSON.stringify({ rule_change: ruleChange, matched })}\n`);

  // GitHub Actions step outputs.
  const ghOut = process.env.GITHUB_OUTPUT;
  if (ghOut) {
    appendFileSync(ghOut, `rule_change=${ruleChange}\n`);
    appendFileSync(ghOut, `rule_change_paths=${matched.join(",")}\n`);
  }
}

main();
