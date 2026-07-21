/** Visible, server-rendered governance facts and thin command forms. */

import {
  EffectivePolicySubjectKindSchema,
  type EffectivePolicySnapshot,
  type GovernanceStudioData,
  type GovernanceTier,
  type PolicyBinding,
} from "../../api/governanceStudio.js";
import type { ReceiptRead } from "../../api/governanceStudioClient.js";
import type { ProjectSummary } from "../../api/types.js";
import { CsrfField } from "../shell/CsrfField.js";
import { GOVERNANCE_STUDIO_CSS } from "./studioStyles.js";

export type GovernanceStudioFlash = { readonly kind: "ok" | "error" | "unknown"; readonly message: string } | undefined;
export type ActiveReceipt =
  | { readonly kind: "verified"; readonly snapshot: EffectivePolicySnapshot }
  | { readonly kind: "unverified" };

export interface GovernanceStudioBodyProps {
  readonly projects: readonly ProjectSummary[];
  readonly project: ProjectSummary | undefined;
  readonly studio: GovernanceStudioData | undefined;
  readonly readFailure: "unavailable" | "malformed" | undefined;
  readonly receipt: ReceiptRead | { readonly kind: "not_requested" | "invalid_query" };
  readonly activeReceipt: ActiveReceipt;
  readonly receiptKind: string | undefined;
  readonly receiptId: string | undefined;
  readonly flash: GovernanceStudioFlash;
  readonly csrfToken: string | undefined;
}

function ProjectPicker(props: Pick<GovernanceStudioBodyProps, "projects" | "project">) {
  return (
    <section class="panel">
      <div class="panel-body">
        <form class="project-picker" method="get" action="/governance">
          <div class="field grow">
            <label for="governance-studio-project">project</label>
            <select id="governance-studio-project" name="projectId" disabled={props.projects.length === 0}>
              {props.projects.length === 0 ? <option value="">no visible projects</option> : null}
              {props.projects.map((project) => (
                <option value={project.projectId} selected={project.projectId === props.project?.projectId}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>
          <button class="btn" type="submit" disabled={props.projects.length === 0}>
            load project
          </button>
        </form>
      </div>
    </section>
  );
}

function BindingPanel(props: { data: GovernanceStudioData; activeReceipt: ActiveReceipt }) {
  const binding = props.data.activeBinding;
  const tier = binding === undefined ? undefined : props.data.tiersById.get(binding.tierId);
  return (
    <section class="panel" data-governance-active-binding>
      <div class="panel-head">
        <h2>active binding</h2>
        <span class="meta">GET …/governance/bindings</span>
      </div>
      <div class="panel-body binding-state">
        {binding === undefined || tier === undefined ? (
          <>
            <strong data-governance-unbound>unbound</strong>
            <span class="hint">
              No active policy is asserted. Bind a verified tier through the governance authority.
            </span>
          </>
        ) : props.activeReceipt.kind === "verified" ? (
          <>
            <strong data-governance-active-tier={tier.id}>{tier.tierName}</strong>
            <Fact label="binding" value={binding.id} />
            <Fact label="tier" value={`${tier.preset} · ${tier.id}`} />
            <Fact label="effective hash" value={binding.effectivePolicyHash} />
          </>
        ) : (
          <div class="state unavailable" data-governance-active-unverified>
            active-unverified — the authority reports a binding, but its exact activation receipt is unavailable or
            inconsistent. The active policy claim is blocked.
          </div>
        )}
      </div>
    </section>
  );
}

function Fact(props: { label: string; value: string }) {
  return (
    <div class="kv">
      <span>{props.label}</span>
      <span>{props.value}</span>
    </div>
  );
}

function RevisionLineage(props: { data: GovernanceStudioData; projectId: string; csrfToken: string | undefined }) {
  return (
    <section class="panel" data-governance-revisions>
      <div class="panel-head">
        <h2>append-only policy lineage</h2>
        <span class="meta">GET …/governance/revisions</span>
      </div>
      <div class="panel-body">
        {props.data.revisions.length === 0 ? (
          <p class="muted" data-governance-revisions-empty>
            No policy revisions exist yet. This is an empty lineage, not an active policy.
          </p>
        ) : (
          <table class="table">
            <thead>
              <tr>
                <th>revision</th>
                <th>parent</th>
                <th>hash</th>
                <th>author</th>
                <th>lifecycle</th>
              </tr>
            </thead>
            <tbody>
              {props.data.revisions.map((revision) => (
                <tr data-governance-revision={revision.id}>
                  <td>
                    #{revision.revisionNumber}
                    <br />
                    {revision.id}
                  </td>
                  <td>{revision.parentRevisionId ?? "root"}</td>
                  <td>{revision.policyHash}</td>
                  <td>{revision.createdBy}</td>
                  <td>
                    <span data-governance-revision-state={revision.status}>{revision.status}</span>
                    <form class="inline" method="post" action="/governance/revisions/activate">
                      <CsrfField token={props.csrfToken} />
                      <input type="hidden" name="projectId" value={props.projectId} />
                      <input type="hidden" name="revisionId" value={revision.id} />
                      <button class="btn" type="submit">
                        record activation
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function Tiers(props: {
  data: GovernanceStudioData;
  activeReceipt: ActiveReceipt;
  projectId: string;
  csrfToken: string | undefined;
}) {
  return (
    <section class="panel" data-governance-tiers>
      <div class="panel-head">
        <h2>tiers and bindings</h2>
        <span class="meta">GET …/tiers + …/bindings</span>
      </div>
      <div class="panel-body">
        {props.data.tiers.length === 0 ? (
          <p class="muted" data-governance-tiers-empty>
            No governance tiers exist for this project.
          </p>
        ) : (
          <table class="table">
            <thead>
              <tr>
                <th>tier</th>
                <th>binding state</th>
                <th>canonical hash</th>
                <th>command</th>
              </tr>
            </thead>
            <tbody>
              {props.data.tiers.map((tier) => (
                <TierRow
                  tier={tier}
                  bindings={props.data.bindings}
                  activeReceipt={props.activeReceipt}
                  projectId={props.projectId}
                  csrfToken={props.csrfToken}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function TierRow(props: {
  tier: GovernanceTier;
  bindings: readonly PolicyBinding[];
  activeReceipt: ActiveReceipt;
  projectId: string;
  csrfToken: string | undefined;
}) {
  const binding = props.bindings.find((candidate) => candidate.tierId === props.tier.id);
  const state =
    binding?.isActive === true
      ? props.activeReceipt.kind === "verified"
        ? "active"
        : "active-unverified"
      : binding === undefined
        ? "unbound"
        : "superseded";
  return (
    <tr data-governance-tier={props.tier.id}>
      <td>
        {props.tier.tierName}
        <br />
        <span class="muted">{props.tier.preset}</span>
      </td>
      <td data-governance-binding-state={state}>{state}</td>
      <td>{props.tier.canonicalHash}</td>
      <td>
        <form class="inline" method="post" action="/governance/tiers/bind">
          <CsrfField token={props.csrfToken} />
          <input type="hidden" name="projectId" value={props.projectId} />
          <input type="hidden" name="tierId" value={props.tier.id} />
          <button class="btn primary" type="submit" disabled={binding?.isActive === true}>
            make active
          </button>
        </form>
      </td>
    </tr>
  );
}

function ReceiptPanel(props: {
  receipt: GovernanceStudioBodyProps["receipt"];
  receiptKind: string | undefined;
  receiptId: string | undefined;
  projectId: string;
}) {
  return (
    <section class="panel" data-governance-receipt-panel>
      <div class="panel-head">
        <h2>effective-policy receipt</h2>
        <span class="meta">GET …/governance/effective/:kind/:id</span>
      </div>
      <div class="panel-body">
        <form class="receipt-form" method="get" action="/governance">
          <input type="hidden" name="projectId" value={props.projectId} />
          <div class="field">
            <label for="receipt-kind">subject kind</label>
            <select id="receipt-kind" name="receiptKind">
              <option value="">select</option>
              {EffectivePolicySubjectKindSchema.options.map((kind) => (
                <option value={kind} selected={kind === props.receiptKind}>
                  {kind}
                </option>
              ))}
            </select>
          </div>
          <div class="field grow">
            <label for="receipt-id">subject id</label>
            <input id="receipt-id" name="receiptId" value={props.receiptId ?? ""} />
          </div>
          <button class="btn" type="submit">
            load exact receipt
          </button>
        </form>
        <ReceiptState receipt={props.receipt} />
      </div>
    </section>
  );
}

function ReceiptState(props: { receipt: GovernanceStudioBodyProps["receipt"] }) {
  const receipt = props.receipt;
  if (receipt.kind === "not_requested")
    return <p class="hint">Provide an exact subject coordinate. Receipt reads never enumerate or invent history.</p>;
  if (receipt.kind === "invalid_query")
    return (
      <div class="state unavailable" data-governance-receipt-invalid>
        Both a supported kind and a nonblank subject id are required; no receipt was read.
      </div>
    );
  if (receipt.kind === "not_found")
    return (
      <div class="state not-found" data-governance-receipt-not-found>
        The requested receipt does not exist. No compiled policy is displayed.
      </div>
    );
  if (receipt.kind === "unavailable" || receipt.kind === "malformed")
    return (
      <div class="state unavailable" data-governance-receipt-unavailable>
        Receipt unavailable or malformed. Do not treat this coordinate as governed.
      </div>
    );
  if ("snapshot" in receipt) return <Receipt snapshot={receipt.snapshot} />;
  return (
    <div class="state unavailable" data-governance-receipt-unavailable>
      Receipt state was not confirmable. Do not treat this coordinate as governed.
    </div>
  );
}

function Receipt(props: { snapshot: EffectivePolicySnapshot }) {
  return (
    <div data-governance-receipt={props.snapshot.id}>
      <div class="kv">
        <span>receipt</span>
        <span>{props.snapshot.id}</span>
      </div>
      <div class="kv">
        <span>binding / tier</span>
        <span>
          {props.snapshot.bindingId} / {props.snapshot.tierId}
        </span>
      </div>
      <div class="kv">
        <span>revision / hash</span>
        <span>
          {props.snapshot.policyRevisionId} / {props.snapshot.effectivePolicyHash}
        </span>
      </div>
      <div class="kv">
        <span>inputs digest</span>
        <span>{props.snapshot.inputsDigest}</span>
      </div>
      <pre class="receipt-json">{prettyJson(props.snapshot.compiledBody)}</pre>
    </div>
  );
}

function AuthorForm(props: { data: GovernanceStudioData; projectId: string; csrfToken: string | undefined }) {
  return (
    <section class="panel" data-governance-author>
      <div class="panel-head">
        <h2>author a policy revision</h2>
        <span class="meta">POST …/governance/revisions</span>
      </div>
      <div class="panel-body">
        <p class="hint">
          Submit the authoritative governance-fragments/v1 config. The orchestrator authors missing fragments and
          rejects invalid or contradictory policies.
        </p>
        <form class="command-form" method="post" action="/governance/revisions">
          <CsrfField token={props.csrfToken} />
          <input type="hidden" name="projectId" value={props.projectId} />
          <div class="field">
            <label for="parent-revision">parent revision (optional)</label>
            <select id="parent-revision" name="parentRevisionId">
              <option value="">new lineage root</option>
              {props.data.revisions.map((revision) => (
                <option value={revision.id}>
                  #{revision.revisionNumber} · {revision.id}
                </option>
              ))}
            </select>
          </div>
          <div class="field grow">
            <label for="fragment-config">fragment config JSON</label>
            <textarea
              id="fragment-config"
              name="fragmentConfig"
              required
              placeholder='{"apiVersion":"tanren.dev/governance-fragments/v1","schemaVersion":1,"fragments":[…]}'
            ></textarea>
          </div>
          <button class="btn primary" type="submit">
            author revision
          </button>
        </form>
      </div>
    </section>
  );
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "receipt body unavailable";
  }
}

export function GovernanceStudioBody(props: GovernanceStudioBodyProps) {
  return (
    <>
      <style data-screen="governance-studio" dangerouslySetInnerHTML={{ __html: GOVERNANCE_STUDIO_CSS }} />
      <div class="page-head">
        <div>
          <div class="eyebrow">▮ project · governance</div>
          <div class="page-title">governance studio</div>
          <div class="sub">append-only lineage, exact effective-policy evidence, and authority-routed commands</div>
        </div>
      </div>
      <div class="page-body">
        <div class="governance-studio">
          <ProjectPicker projects={props.projects} project={props.project} />
          {props.flash === undefined ? null : (
            <div class={`flash ${props.flash.kind}`} role="status" data-governance-studio-flash={props.flash.kind}>
              {props.flash.message}
            </div>
          )}
          {props.project === undefined ? (
            <section class="panel">
              <div class="panel-body state unavailable" data-governance-studio-no-project>
                {props.projects.length === 0
                  ? "No project is visible; governance cannot be scoped."
                  : "The requested project is not visible; no governance claim is shown."}
              </div>
            </section>
          ) : props.studio === undefined ? (
            <section class="panel">
              <div class="panel-body state unavailable" data-governance-studio-unavailable>
                {props.readFailure === "malformed"
                  ? "Governance responses were malformed or inconsistent. No policy, binding, or receipt was inferred."
                  : "Governance reads are unavailable. This is not an empty or active policy state."}
              </div>
            </section>
          ) : (
            <>
              <div class="studio-grid">
                <BindingPanel data={props.studio} activeReceipt={props.activeReceipt} />
                <ReceiptPanel
                  receipt={props.receipt}
                  receiptKind={props.receiptKind}
                  receiptId={props.receiptId}
                  projectId={props.project.projectId}
                />
              </div>
              <RevisionLineage data={props.studio} projectId={props.project.projectId} csrfToken={props.csrfToken} />
              <Tiers
                data={props.studio}
                activeReceipt={props.activeReceipt}
                projectId={props.project.projectId}
                csrfToken={props.csrfToken}
              />
              <AuthorForm data={props.studio} projectId={props.project.projectId} csrfToken={props.csrfToken} />
            </>
          )}
        </div>
      </div>
    </>
  );
}
