#!/usr/bin/env node
// =============================================================================
// review-bodies.mjs — pure text/payload composition for post-review.mjs.
// -----------------------------------------------------------------------------
// Extracted from post-review.mjs to keep that file under the 500-line lint cap
// (the same reason post-review.selftest.mjs was split out). NOTHING here calls
// `gh` or touches the network — these are deterministic string/object builders
// (marker relocation, finding partitioning, inline/comment/review/summary
// bodies). post-review.mjs imports what it needs and does all the I/O.
// =============================================================================

import { parseMarker, serializeMarker } from "./lib.mjs";

export const STICKY_HEADER = "## OCR review";

export function isGate(p) {
  return p === "P0" || p === "P1";
}
export function isGrounded(f) {
  return f.grounded === true && Number(f.start_line) > 0;
}

// Rewrite the sticky marker's `open` entries so each carries the LOCATION
// (path + line range) of its finding, drawn from the reconciled finding records.
// The prior round can then tell an ADDRESSED finding (its hunk changed) from a
// nondeterministic disappearance (#247). Findings supply the authoritative
// location; a marker fp with no matching finding keeps whatever it already had
// (reconcile-provided location, or bare for legacy/unlocatable).
export function relocateMarker(markerStr, findings) {
  if (!markerStr) return markerStr;
  const state = parseMarker(markerStr);
  const locByFp = new Map();
  for (const f of findings || []) {
    if (!f || !f.fingerprint || f.state === "addressed") continue;
    if (!isGate(f.priority)) continue;
    const s = Number(f.start_line) || 0;
    const e = Number(f.end_line) || s;
    if (f.path && s > 0) locByFp.set(f.fingerprint, { path: f.path, start_line: s, end_line: e });
  }
  state.open = (state.open || []).map((o) => {
    const entry = typeof o === "string" ? { fp: o } : { ...o };
    const loc = locByFp.get(entry.fp);
    return loc ? { fp: entry.fp, path: loc.path, start_line: loc.start_line, end_line: loc.end_line } : entry;
  });
  return serializeMarker(state);
}

export function partitionFindings(findings, maxInline) {
  const open = findings.filter((f) => f.state !== "addressed");
  const grounded = open.filter((f) => isGrounded(f));
  const ungrounded = open.filter((f) => !isGrounded(f));
  const inline = grounded.slice(0, Math.max(0, maxInline));
  const overflow = grounded.slice(Math.max(0, maxInline));
  return { open, inline, overflow, ungrounded };
}

export function inlineBody(f) {
  return `${prio(f)} ${bold(f.title)}\n\n${f.body || ""}\n\n<!-- ocr-finding:${f.fingerprint} -->`;
}

// The line a comment anchors to (the hunk end, or the single line). GitHub reports
// this back as the comment's `line`, so it is the value we diff to detect a move.
export function anchorLine(f) {
  const start = Number(f.start_line);
  const end = Number(f.end_line) || start;
  return end > start ? end : start;
}

// A standalone review comment payload (POST /pulls/{pr}/comments): carries its own
// commit_id (a review-attached comment inherits the review's, a standalone one does
// not), path, line/range, side, and the fp-marked body.
export function commentPayload(f, headSha) {
  const start = Number(f.start_line);
  const end = Number(f.end_line) || start;
  const c = { commit_id: headSha, path: f.path, body: inlineBody(f), side: "RIGHT" };
  if (end > start) {
    c.start_line = start;
    c.start_side = "RIGHT";
    c.line = end;
  } else {
    c.line = start;
  }
  return c;
}

export function prio(f) {
  return `[${f.priority || "P?"}]`;
}
export function bold(s) {
  return `**${String(s || "").trim()}**`;
}

// The short body a submitted review carries (NO inline comments[]). It MUST match
// the ACTUAL submitted event: a COMMENT fallback (the identity cannot APPROVE —
// e.g. github-actions[bot]) must NOT claim "Approved"; an uncertified review
// (fail-closed) must say so regardless of the event we could submit.
export function reviewBody(event, gateCount, stashCount, { incomplete = false } = {}) {
  const fu = stashCount > 0 ? ` ${stashCount} P2/P3 filed as follow-ups.` : "";
  if (incomplete)
    return `${STICKY_HEADER}: **Review did not complete** — the automated reviewer could not run on this diff (missing LLM key on a fork PR, or an OCR error), so it cannot certify these changes. \`review/verdict\` fails closed; a maintainer must run the review before merge.`;
  if (event === "REQUEST_CHANGES")
    return `${STICKY_HEADER}: **Changes requested** — ${gateCount} open P0/P1 finding(s). See the inline comments and the pinned summary.`;
  if (event === "APPROVE") return `${STICKY_HEADER}: **Approved** — no open P0/P1 findings.${fu}`;
  return `${STICKY_HEADER}: No open P0/P1 findings — \`review/verdict\` passes.${fu}`;
}

export function summaryBody({
  pr,
  sha,
  open,
  overflow,
  ungrounded,
  addressed,
  marker,
  stashB64,
  reviewComplete = true,
}) {
  const lines = [STICKY_HEADER, "", `Reviewed head \`${String(sha).slice(0, 12)}\` for PR #${pr}.`, ""];

  const gate = open.filter((f) => isGate(f.priority));
  if (reviewComplete === true) {
    lines.push(
      gate.length > 0
        ? `**${gate.length} open P0/P1 finding(s) — \`review/verdict\` will FAIL.**`
        : `No open P0/P1 findings — \`review/verdict\` may pass; P2/P3 stashed as follow-ups.`,
      "",
    );
  } else {
    // FAIL-CLOSED: the automated review could not run to completion (e.g. a fork
    // PR has no LLM key, or OCR crashed / returned a partial stream). Zero
    // findings here is "not reviewed", NOT "clean" — say so and fail the gate.
    lines.push(
      "**Review did not complete — `review/verdict` FAILS CLOSED.**",
      "The automated reviewer could not run on this diff (missing LLM key on a fork PR, or an OCR error), so it **cannot certify** these changes. This is not an approval. A maintainer must run the review before merge.",
      "",
    );
  }

  if (open.length > 0) {
    lines.push("### Findings this round");
    for (const f of open) {
      const loc = Number(f.start_line) > 0 ? `${f.path}:${f.start_line}` : `${f.path} (unlocatable)`;
      lines.push(`- ${prio(f)} ${String(f.title || "").trim()} — \`${loc}\`${f.state ? ` _(${f.state})_` : ""}`);
    }
    lines.push("");
  }

  // Never drop: ungrounded + overflow inline findings live here in full.
  const rolled = [...ungrounded, ...overflow];
  if (rolled.length > 0) {
    lines.push("### Findings not shown inline (rolled into summary — never dropped)");
    for (const f of rolled) {
      lines.push(`- ${prio(f)} ${bold(f.title)} — \`${f.path}${Number(f.start_line) > 0 ? ":" + f.start_line : ""}\``);
      if (f.body) lines.push(`  ${String(f.body).replaceAll(/\s+/gu, " ").trim().slice(0, 500)}`);
    }
    lines.push("");
  }

  if (addressed && addressed.length > 0) {
    lines.push(
      `### Resolved since last review`,
      `${addressed.length} prior finding(s) addressed (hunk changed, no longer raised).`,
      "",
    );
  }

  lines.push(`<!-- ocr-stash ${stashB64} -->`);
  lines.push(marker);
  return lines.join("\n");
}
