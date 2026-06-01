// P3-0022 candidate-inbox: deterministic, grounded triage answerer.
//
// The fallback `TriageAnswerer` used when no provider Answerer is wired — the
// analogue of P3-0014's `createDeterministicDiscoveryAnswerer`. It is grounded
// (it reads the candidate + the existing-spec list it is handed) but
// deterministic, so the triage endpoint is live without provider infra and the
// verdict is testable without hitting an LLM. Production swaps in a
// provider-backed answerer via the engine's `answerer` dep.
//
// Triage logic (deterministic, mirrors the hi-fi `CANDIDATES` read-outs):
//   • A system / scheduled-audit source → auto_routable (no manual call).
//   • A title that token-overlaps an existing DONE/MERGED spec → dedupe_close,
//     with that spec id captured for the close-as-dup link.
//   • A fail-severity candidate that overlaps an IN-FLIGHT spec → needs_call,
//     placement = fold into the live run (the hi-fi sentry→in-flight case).
//   • Otherwise → needs_call with a proposed DAG placement.

import type { CandidateTriage, TriageAnswerer, TriageAnswererContext } from "../../../src/engine/forge/inbox/types.js";

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "to",
  "for",
  "of",
  "on",
  "in",
  "and",
  "or",
  "with",
  "fix",
  "bug",
  "feature",
  "add",
  "issue",
  "new",
  "is",
  "are",
  "by",
  "from",
]);

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replaceAll(/[^a-z0-9\s]/gu, " ")
      .split(/\s+/u)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
  );
}

// Token-overlap score against a spec title; deterministic dedupe/match signal.
function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) {
    if (b.has(t)) n += 1;
  }
  return n;
}

interface Match {
  specId: string;
  title: string;
  status: string;
  score: number;
}

function bestMatch(candidateTokens: Set<string>, specs: TriageAnswererContext["existingSpecs"]): Match | undefined {
  let best: Match | undefined;
  for (const spec of specs) {
    const score = overlap(candidateTokens, tokens(spec.title));
    if (score >= 2 && (best === undefined || score > best.score)) {
      best = { specId: spec.specId, title: spec.title, status: spec.status, score };
    }
  }
  return best;
}

function variantFor(severity: string): CandidateTriage["discoveryVariant"] {
  return severity === "fail" ? "bug" : "feature";
}

export function createDeterministicTriageAnswerer(): TriageAnswerer {
  return {
    async triage(context: TriageAnswererContext): Promise<CandidateTriage> {
      const { candidate, source } = context;

      // System sources auto-route: their findings are pre-vetted audits.
      if (source.autoRoute || source.kind === "system" || source.kind === "scheduled_audit") {
        return CandidateTriageOk({
          dedupe: "no match · audit finding",
          match: "fits an existing behavior · audit-spec-able",
          placement: `auto → ${candidate.projectId ?? "project"} · queued`,
          verdict: "auto_routable",
          duplicateOfSpecId: null,
          discoveryVariant: variantFor(candidate.severity),
        });
      }

      const candidateTokens = tokens(`${candidate.title} ${candidate.body}`);
      const match = bestMatch(candidateTokens, context.existingSpecs);
      const done = ["done", "merged"];
      const inFlight = ["in_flight", "live", "active"];

      // A strong match to a shipped spec → close as duplicate.
      if (match !== undefined && done.includes(match.status.toLowerCase())) {
        return CandidateTriageOk({
          dedupe: `duplicate of ${match.specId} (${match.title}) · shipped`,
          match: "already merged",
          placement: "forge recommends closing as done",
          verdict: "dedupe_close",
          duplicateOfSpecId: match.specId,
          discoveryVariant: variantFor(candidate.severity),
        });
      }

      // A fail touching an in-flight spec → fold into the live run.
      if (match !== undefined && inFlight.includes(match.status.toLowerCase())) {
        return CandidateTriageOk({
          dedupe: "no match",
          match: `touches in-flight ${match.specId}`,
          placement: "forge suggests folding into the live run",
          verdict: "needs_call",
          duplicateOfSpecId: null,
          discoveryVariant: candidate.severity === "fail" ? "bug" : "feature",
        });
      }

      // Otherwise: a fresh candidate awaiting an operator placement call.
      return CandidateTriageOk({
        dedupe: match === undefined ? "no match" : `partial overlap with ${match.specId}`,
        match: candidate.severity === "fail" ? "new behavior · hardening" : "new behavior",
        placement: "forge proposes a new spec · P1 · placement is your call",
        verdict: "needs_call",
        duplicateOfSpecId: null,
        discoveryVariant: variantFor(candidate.severity),
      });
    },
  };
}

// Small helper so each branch returns a fully-shaped triage object.
function CandidateTriageOk(t: CandidateTriage): CandidateTriage {
  return t;
}
