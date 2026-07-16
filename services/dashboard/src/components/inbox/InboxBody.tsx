/**
 * candidate-inbox surface (the hi-fi `view-inbox` flow). Composes:
 *   - the CONFIGURABLE source list (connector kind + detail + on/auto state);
 *   - the candidate stream, each with its Forge TRIAGE read-out (dedupe /
 *     match / placement / verdict) — the same answerer seam as the conversation/discovery surfaces;
 *   - per-candidate ACTIONS that map to the orchestrator inbox routes:
 *       accept → opens discovery with the candidate (hand-off),
 *       fold-into-live-run / dismiss / close-as-dup.
 *
 * System sources auto-route (verdict auto_routable → candidate `auto_routed`);
 * external candidates rest at `triaged` awaiting an operator call. The writes
 * stay server-side: each action is a form POST to the inbox route; accept links
 * to the discovery surface scoped to the candidate's project.
 */

import type {
  Candidate,
  InboxSnapshot,
  InboxSource,
  InboxSourceAttention,
  TriageVerdict,
} from "../../api/inboxTypes.js";
import { CsrfField } from "../shell/CsrfField.js";
import { ScreenStyles } from "../project/screenStyles.js";
import { KpiStrip, PageHead } from "../project/shared.js";
import { InboxStyles } from "./inboxStyles.js";

const SOURCE_GLYPH: Record<string, string> = {
  issues: "◍",
  errors: "×",
  system: "⟳",
  scheduled_audit: "⟳",
  manual: "✎",
};

const VERDICT_META: Record<TriageVerdict, { cls: string; label: string }> = {
  auto_routable: { cls: "auto", label: "auto-routed" },
  needs_call: { cls: "decide", label: "needs you" },
  dedupe_close: { cls: "dupe", label: "duplicate" },
};

const RESOLVED_LABEL: Record<string, string> = {
  auto_routed: "auto-routed",
  accepted: "accepted · in discovery",
  folded: "folded into live run",
  dismissed: "dismissed",
  closed_duplicate: "closed · duplicate",
};

function isResolved(c: Candidate): boolean {
  return ["auto_routed", "accepted", "folded", "dismissed", "closed_duplicate"].includes(c.status);
}

function sourceAttention(source: InboxSource): InboxSourceAttention | undefined {
  const raw = source.config["attention"];
  if (source.config["state"] !== "needs_attention" || typeof raw !== "object" || raw === null) return undefined;
  const candidate = raw as Partial<InboxSourceAttention>;
  if (
    candidate.state !== "needs_attention" ||
    typeof candidate.code !== "string" ||
    typeof candidate.message !== "string" ||
    typeof candidate.observedAt !== "string"
  ) {
    return undefined;
  }
  return candidate as InboxSourceAttention;
}

function SourceRow(props: { source: InboxSource }) {
  const { source } = props;
  const attention = sourceAttention(source);
  return (
    <div
      class={`source-row${source.enabled ? " on" : ""}${attention === undefined ? "" : " needs-attention"}`}
      data-source-id={source.id}
      data-source-attention={attention?.code}
    >
      <span class="sg">{SOURCE_GLYPH[source.kind] ?? "▮"}</span>
      <div class="smid">
        <div class="sn">
          {source.name}
          {source.autoRoute && <span class="auto-tag">auto</span>}
        </div>
        <div class="sd">{source.detail}</div>
        {attention !== undefined && <div class="sd">needs attention · {attention.message}</div>}
      </div>
      <div class={`toggle${source.enabled ? " on" : ""}`}>
        {attention === undefined ? (source.enabled ? "on" : "off") : "attention"}
      </div>
    </div>
  );
}

function TriageReadout(props: { candidate: Candidate }) {
  const t = props.candidate.triage;
  if (t === null) return <></>;
  return (
    <div class="triage" data-triage>
      <div class="trow">
        <span class="tk">dedupe</span>
        <span class="tv">{t.dedupe}</span>
      </div>
      <div class="trow">
        <span class="tk">match</span>
        <span class="tv">{t.match}</span>
      </div>
      <div class="trow">
        <span class="tk">placement</span>
        <span class="tv accent">{t.placement}</span>
      </div>
    </div>
  );
}

function actionForm(
  orgId: string,
  candidateId: string,
  verb: string,
  children: unknown,
  csrfToken: string | undefined,
) {
  return (
    <form method="post" action={`/inbox/candidates/${candidateId}/${verb}`} style="display:contents">
      <CsrfField token={csrfToken} />
      <input type="hidden" name="orgId" value={orgId} />
      {children}
    </form>
  );
}

function CandidateActions(props: { orgId: string; candidate: Candidate; csrfToken: string | undefined }) {
  const { candidate, orgId, csrfToken } = props;
  if (isResolved(candidate)) {
    const label = RESOLVED_LABEL[candidate.status] ?? candidate.status;
    return (
      <div class="cand-actions">
        <span class="resolved-note">✓ {label}</span>
        {candidate.resolvedSpecId !== null && candidate.projectId !== null && (
          <a class="btn ghost" style="font-size:11px" href={`/projects/${candidate.projectId}/discovery`}>
            view in discovery ↗
          </a>
        )}
      </div>
    );
  }
  const verdict = candidate.triage?.verdict ?? "needs_call";
  if (verdict === "dedupe_close") {
    return (
      <div class="cand-actions">
        {actionForm(
          orgId,
          candidate.id,
          "close-duplicate",
          <button class="btn primary notched" style="font-size:11px" type="submit">
            close as done
          </button>,
          csrfToken,
        )}
        {actionForm(
          orgId,
          candidate.id,
          "dismiss",
          <button class="btn ghost" style="font-size:11px" type="submit">
            keep open
          </button>,
          csrfToken,
        )}
      </div>
    );
  }
  // needs_call → the three external-issue actions; accept opens discovery.
  const discoveryHref = candidate.projectId === null ? "/discovery" : `/projects/${candidate.projectId}/discovery`;
  return (
    <div class="cand-actions" data-actions="needs-call">
      <a class="btn primary notched" style="font-size:11px" href={discoveryHref} data-action="accept">
        accept · open in discovery ↗
      </a>
      {actionForm(
        orgId,
        candidate.id,
        "fold",
        <button class="btn" style="font-size:11px" type="submit" data-action="fold">
          fold into live run
        </button>,
        csrfToken,
      )}
      {actionForm(
        orgId,
        candidate.id,
        "dismiss",
        <button class="btn ghost" style="font-size:11px" type="submit" data-action="dismiss">
          dismiss
        </button>,
        csrfToken,
      )}
    </div>
  );
}

function CandidateCard(props: { orgId: string; candidate: Candidate; csrfToken: string | undefined }) {
  const { candidate, orgId, csrfToken } = props;
  const vm = VERDICT_META[candidate.triage?.verdict ?? "needs_call"];
  return (
    <div class={`candidate v-${vm.cls}${isResolved(candidate) ? " resolved" : ""}`} data-candidate-id={candidate.id}>
      <div class="cand-head">
        <span class={`cand-src sev-${candidate.severity}`}>
          {SOURCE_GLYPH[candidate.sourceKind] ?? "▮"} {candidate.sourceName}
        </span>
        <span class="cand-proj">{candidate.projectId ?? "org-wide"}</span>
        <span class={`cand-verdict ${vm.cls}`}>
          {isResolved(candidate) ? (RESOLVED_LABEL[candidate.status] ?? vm.label) : vm.label}
        </span>
      </div>
      <div class="cand-title">{candidate.title}</div>
      {candidate.body !== "" && <div class="cand-body">{candidate.body.slice(0, 400)}</div>}
      <TriageReadout candidate={candidate} />
      <CandidateActions orgId={orgId} candidate={candidate} csrfToken={csrfToken} />
    </div>
  );
}

export interface InboxBodyProps {
  orgId: string;
  snapshot: InboxSnapshot;
  error?: string;
  /** Session CSRF for pure HTML form posts. */
  csrfToken?: string;
}

export function InboxBody(props: InboxBodyProps) {
  const { sources, candidates } = props.snapshot;
  const csrfToken = props.csrfToken;
  const enabledSources = sources.filter((s) => s.enabled);
  const counts = {
    auto: candidates.filter((c) => c.status === "auto_routed").length,
    decide: candidates.filter((c) => c.triage?.verdict === "needs_call" && !isResolved(c)).length,
    dupe: candidates.filter((c) => c.triage?.verdict === "dedupe_close").length,
  };
  return (
    <div class="p2b">
      <ScreenStyles />
      <InboxStyles />
      <PageHead
        eyebrow="▮ intake · candidate inbox"
        title={
          <>
            where work <em>comes from</em>
          </>
        }
        sub={<>configurable issue sources · forge triages each into the dag · you decide placement</>}
        actions={
          <a class="btn ghost" href="/discovery">
            discover manually ↗
          </a>
        }
      />
      <div class="page-body">
        <KpiStrip
          items={[
            { k: "candidates", v: String(candidates.length) },
            { k: "auto-routed", v: String(counts.auto) },
            { k: "needs you", v: String(counts.decide), tone: "hot" },
            { k: "duplicates", v: String(counts.dupe) },
            { k: "sources", v: String(enabledSources.length) },
          ]}
        />
        {props.error !== undefined && (
          <div class="placeholder-card" style="border-left:2px solid var(--ember-08)">
            {props.error}
          </div>
        )}
        <div class="inbox-split">
          <div>
            <div class="sect-label" style="margin-bottom:8px">
              sources · configurable
            </div>
            <div class="source-list">
              {sources.length === 0 && (
                <div class="source-note">
                  <div class="nlabel">no sources yet</div>
                  <div class="nbody">
                    Connect a GitHub Issues feed (or any polled endpoint) to start ingesting candidates.
                  </div>
                </div>
              )}
              {sources.map((source) => (
                <SourceRow source={source} />
              ))}
              <div class="source-note">
                <div class="nlabel">no hardcoded sources</div>
                <div class="nbody">
                  Any webhook or polled endpoint can feed candidates. System sources like scheduled audits auto-route
                  their findings; external issues wait for your call.
                </div>
              </div>
            </div>
          </div>
          <div class="candidate-stream">
            {candidates.length === 0 && (
              <div class="placeholder-card">No candidates yet — ingest a source to populate the inbox.</div>
            )}
            {candidates.map((candidate) => (
              <CandidateCard orgId={props.orgId} candidate={candidate} csrfToken={csrfToken} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
