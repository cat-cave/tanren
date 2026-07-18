/**
 * bh-14b — the loop-detail body: the six SEPARATE truth badges plus the
 * reproduce → fix → re-verify causal graph, rendered from the bh-14a sealed
 * resolution-proof chain.
 *
 * The badges are six independent DOM fields (`data-badge` / `data-tone`), never
 * OR'd into one green. The causal chain links the loop's spec origins, its
 * baseline/production verification runs, and the resolution decision, so a
 * cosmetic fix reads as: demo GREEN, symptom RED, decision blocked.
 */

import type { LoopProofResponse, PersistedProof, ProofBadges, ProofSections } from "../../api/selfHealing.js";
import { BADGE_ORDER, badgeTone } from "./badges.js";
import { SELF_HEALING_SCREEN_CSS } from "./styles.js";

export interface LoopDetailBodyProps {
  proofResponse: LoopProofResponse | undefined;
  loopId: string;
  projectId: string;
  /** Whether the org/project scope was visible for the read. */
  missingScope: boolean;
}

/** The primary proof to render: prefer the verified-closed terminal, else newest. */
function primaryProof(proofs: readonly PersistedProof[]): PersistedProof | undefined {
  const closed = proofs.find((p) => p.terminal === "authorized_verified_closed");
  return closed ?? proofs.at(-1);
}

function TruthBadges(props: { badges: ProofBadges }) {
  return (
    <div class="badges">
      {BADGE_ORDER.map(({ key, label }) => {
        const value = props.badges[key];
        return (
          <span class="badge" data-badge={key} data-tone={badgeTone(value)}>
            <span class="b-label">{label}</span>
            <span class="b-value">{value}</span>
          </span>
        );
      })}
    </div>
  );
}

interface ChainNode {
  readonly kind: string;
  readonly body: string;
  readonly symptomFailed?: boolean;
}

function chainNodes(sections: ProofSections): ChainNode[] {
  const nodes: ChainNode[] = [
    {
      kind: "opened",
      body: `loop ${sections.issue_loop.issueLoopId} · ${sections.issue_loop.providerObjectId ?? "no provider ref"}`,
    },
  ];
  if (sections.triage !== null) {
    nodes.push({ kind: "triaged", body: `task ${sections.triage.taskId} · ${sections.triage.status ?? "—"}` });
  }
  for (const origin of sections.spec_origins) {
    nodes.push({
      kind: `spec origin · ${origin.role}`,
      body: `spec ${origin.specId} · attempt ${origin.attemptNumber ?? "—"}`,
    });
  }
  if (sections.baseline !== null) {
    nodes.push({
      kind: "baseline reproduced",
      body: `run ${sections.baseline.verificationRunId} · ${sections.baseline.classification ?? "—"}`,
    });
  }
  if (sections.merge !== null) {
    nodes.push({ kind: "merged", body: `sha ${sections.merge.mergeSha.slice(0, 12)}` });
  }
  if (sections.deployment !== null) {
    nodes.push({
      kind: "deployed",
      body: `${sections.deployment.url ?? "no url"} · ${sections.deployment.state ?? "—"} · ${sections.deployment.artifactDigest ?? "no digest"}`,
    });
  }
  if (sections.production_symptom !== null) {
    const sym = sections.production_symptom;
    nodes.push({
      kind: "production symptom re-verify",
      body: `${sym.outcome} · ${sym.classification ?? "—"} · ${sym.assertions.length} assertion(s) · ${sym.probedUrl ?? "no url"}`,
      symptomFailed: sym.outcome === "failed",
    });
  }
  nodes.push({
    kind: "resolution decision",
    body: `${sections.resolution_decision.decision} · authority ${sections.resolution_decision.authorityVersion}`,
  });
  if (sections.source_sync !== null) {
    nodes.push({ kind: "source sync", body: `${sections.source_sync.operation} · ${sections.source_sync.state}` });
  }
  return nodes;
}

function CausalChain(props: { sections: ProofSections }) {
  const nodes = chainNodes(props.sections);
  return (
    <div class="chain">
      {nodes.map((node, index) => (
        <>
          {index > 0 ? <div class="chain-arrow">↓</div> : null}
          <div class={`chain-node${node.symptomFailed === true ? " symptom-failed" : ""}`} data-kind={node.kind}>
            <span class="cn-kind">{node.kind}</span>
            <span class="cn-body">{node.body}</span>
          </div>
        </>
      ))}
    </div>
  );
}

function ProofView(props: { proof: PersistedProof }) {
  const { proof } = props;
  return (
    <>
      <section class="panel">
        <div class="panel-pad">
          <div class="mini-eyebrow">
            truth badges · terminal {proof.terminal} · seal {proof.proof.proofHash.slice(0, 18)}
          </div>
          <TruthBadges badges={proof.proof.badges} />
          {proof.verification.valid ? null : (
            <div class="tamper" data-tamper="true">
              ⚠ proof no longer verifies — evidence diverged at {proof.verification.divergedAt ?? "unknown"}.
            </div>
          )}
        </div>
      </section>
      <section class="panel">
        <div class="panel-pad">
          <div class="mini-eyebrow">causal chain · reproduce → fix → re-verify</div>
          <CausalChain sections={proof.proof.evidence.sections} />
        </div>
      </section>
    </>
  );
}

export function LoopDetailBody(props: LoopDetailBodyProps) {
  const { proofResponse, loopId, projectId, missingScope } = props;
  const proof = proofResponse === undefined ? undefined : primaryProof(proofResponse.proofs);
  return (
    <>
      <style data-screen="self-healing" dangerouslySetInnerHTML={{ __html: SELF_HEALING_SCREEN_CSS }} />
      <div class="page-head">
        <div>
          <div class="eyebrow">✦ self-healing · loop detail · {projectId}</div>
          <div class="page-title">{loopId}</div>
        </div>
        <div class="filters">
          <a class="pill" href="/self-healing">
            ← funnel
          </a>
        </div>
      </div>
      <div class="page-body">
        <div class="self-healing">
          {missingScope ? (
            <section class="panel">
              <div class="panel-pad">
                <div class="empty">This loop's org/project scope is not visible to you.</div>
              </div>
            </section>
          ) : proof === undefined ? (
            <section class="panel">
              <div class="panel-pad">
                <div class="empty">
                  No sealed resolution proof for this loop yet. A proof seals only when the loop reaches a terminal
                  resolution — an authorized verified-close, or a blocked resolution.
                </div>
              </div>
            </section>
          ) : (
            <ProofView proof={proof} />
          )}
        </div>
      </div>
    </>
  );
}
