/**
 * Org integrations two-plane panel body.
 *
 * Plane A — link a provider once at the org (sentry / slack / deploy.vercel /
 * deploy.flyio). Hetzner is the allocator plane and is intentionally absent.
 * Plane B — enable a capability per project from the org grant.
 *
 * Presentation only for the read side; link/enable POSTs go through the
 * dashboard route proxies. `not_linked` is a structured outcome (never an
 * error). Read failure → "unavailable", never a fabricated empty grant list.
 */

import {
  LINKABLE_PROVIDER_KINDS,
  PROJECT_CAPABILITIES,
  type IntegrationLifecycleInventory,
  type OrgIntegrationSummary,
  type PrincipalSelectionCandidate,
} from "../../api/integrations.js";
import { CsrfField } from "../shell/CsrfField.js";
import { capabilitiesLabel, isProviderLinked, providerLabel, statusLabel } from "./format.js";
import { INTEGRATIONS_SCREEN_CSS } from "./styles.js";

export interface IntegrationsBodyProps {
  /** Org grants, or `undefined` when the list read failed. */
  integrations: OrgIntegrationSummary[] | undefined;
  /** Active project id for Plane-B enable forms (empty when no project). */
  projectId: string;
  /** Foundation lifecycle read model; undefined means unavailable, never zero. */
  lifecycle: IntegrationLifecycleInventory | undefined;
  /** Project name for the eyebrow scope line. */
  projectName: string;
  /** Whether the operator has a visible project at all. */
  noProject: boolean;
  /** Project collection read failed; distinct from a legitimate empty list. */
  projectsUnavailable: boolean;
  /** Whether the operator is an org admin (link form write). */
  isOrgAdmin: boolean;
  /** Optional flash from a prior link/enable redirect. */
  notice?: string;
  /**
   * Optional structured not_linked outcome from a prior enable attempt — the
   * 200 path, not an error. Rendered as a link-first affordance.
   */
  notLinked?: { providerKind: string; message?: string };
  /** A provider is linked, but this project must choose one exact account. */
  selectionRequired?: { providerKind: string; message?: string };
  /**
   * Multi-principal link awaiting explicit principal selection — CSRF form
   * over sanitized durable candidates + operation id.
   */
  principalSelection?: {
    providerKind: string;
    operationId: string;
    candidates: PrincipalSelectionCandidate[];
    status?: "awaiting" | "invalidated" | "pending" | "failed" | "completed" | "unavailable";
  };
  /** Session CSRF for pure HTML form posts. */
  csrfToken?: string;
}

export function IntegrationsBody(props: IntegrationsBodyProps) {
  const {
    integrations,
    projectId,
    lifecycle,
    projectName,
    noProject,
    projectsUnavailable,
    isOrgAdmin,
    notice,
    notLinked,
    selectionRequired,
    principalSelection,
    csrfToken,
  } = props;
  const unavailable = integrations === undefined;
  const grants = integrations ?? [];

  return (
    <>
      <style data-screen="integrations" dangerouslySetInnerHTML={{ __html: INTEGRATIONS_SCREEN_CSS }} />
      <div class="page-head">
        <div>
          <div class="eyebrow">
            ▮ org · integrations · two-plane ·{" "}
            {projectsUnavailable ? "projects unavailable" : projectName || "no project"}
          </div>
          <div class="page-title">link once, enable per project</div>
        </div>
      </div>
      <div class="page-body">
        <div class="integrations-screen">
          {notice === undefined || notice === "" ? null : <div class="notice">{notice}</div>}
          {notLinked === undefined ? null : (
            <div class="notice warn" data-not-linked={notLinked.providerKind}>
              not linked — {providerLabel(notLinked.providerKind)}
              {notLinked.message === undefined || notLinked.message === ""
                ? ". link the provider at the org level first."
                : `: ${notLinked.message}`}
            </div>
          )}
          {selectionRequired === undefined ? null : (
            <div class="notice warn" data-selection-required={selectionRequired.providerKind}>
              account selection required — {providerLabel(selectionRequired.providerKind)}
              {selectionRequired.message === undefined || selectionRequired.message === ""
                ? ". choose an account below before enabling this capability."
                : `: ${selectionRequired.message}`}
            </div>
          )}
          {principalSelection === undefined ? null : (
            <PrincipalSelectionPanel panel={principalSelection} csrfToken={csrfToken} />
          )}

          {/* ── Plane A: org grants ─────────────────────────────────────── */}
          <section class="panel">
            <div class="panel-pad">
              <div class="mini-eyebrow">
                plane a · org grants <span class="window-tag">(link provider once · refs only)</span>
              </div>
              {unavailable ? (
                <div class="empty" data-integrations-unavailable>
                  Integrations unavailable — the orchestrator list read failed. No grant list is fabricated.
                </div>
              ) : grants.length === 0 ? (
                <div class="empty" data-integrations-empty>
                  No providers linked yet. Link sentry, slack, or a deploy provider below — once, for the whole org.
                  Hetzner is the allocator plane and is not configured here.
                </div>
              ) : (
                <div class="int-grid">
                  {grants.map((row) => (
                    <GrantCard row={row} projectId={projectId} csrfToken={csrfToken} />
                  ))}
                </div>
              )}

              {isOrgAdmin && !unavailable ? (
                <form class="link-form" method="post" action="/integrations/link" data-link-form>
                  <CsrfField token={csrfToken} />
                  <div class="field">
                    <label for="providerKind">provider</label>
                    <select id="providerKind" name="providerKind" required>
                      {LINKABLE_PROVIDER_KINDS.map((kind) => (
                        <option value={kind}>{providerLabel(kind)}</option>
                      ))}
                    </select>
                  </div>
                  <div class="field">
                    <label for="token">token (write-only · never echoed)</label>
                    <input
                      id="token"
                      name="token"
                      type="password"
                      required
                      autocomplete="off"
                      placeholder="provider API token"
                    />
                  </div>
                  <input type="hidden" name="idempotencyKey" value={`link-${Date.now()}`} />
                  <button class="btn primary" type="submit">
                    link &amp; verify principal
                  </button>
                </form>
              ) : null}
              {!isOrgAdmin && !unavailable ? (
                <div class="note">
                  <b>↑ org-admin only.</b> Linking a provider requires org admin. Members can still enable already-
                  linked capabilities on a project below.
                </div>
              ) : (
                <div class="note">
                  <b>↑ plane a.</b> The provider verifies the principal; the token is staged and generation-addressed
                  and never echoed. Multi-principal credentials require explicit selection.
                </div>
              )}
            </div>
          </section>

          {/* ── in-1: durable lifecycle foundation ─────────────────────── */}
          <section class="panel" data-lifecycle-inventory>
            <div class="panel-pad">
              <div class="mini-eyebrow">
                integration lifecycle <span class="window-tag">(project · durable state)</span>
              </div>
              {projectsUnavailable ? (
                <div class="empty" data-projects-unavailable>
                  Projects unavailable — lifecycle state cannot be scoped safely.
                </div>
              ) : noProject ? (
                <div class="empty">No project visible; lifecycle state is not applicable.</div>
              ) : unavailable || lifecycle === undefined ? (
                <div class="empty" data-lifecycle-unavailable>
                  Lifecycle inventory unavailable — no zero counts are fabricated.
                </div>
              ) : (
                <div class="int-grid">
                  <LifecycleCard
                    label="requirements"
                    value={lifecycle.requirements.total}
                    detail={`${lifecycle.requirements.needsAttention} need attention`}
                  />
                  <LifecycleCard
                    label="capability nodes"
                    value={lifecycle.capabilityNodes.total}
                    detail={`${lifecycle.capabilityNodes.ready} ready · ${lifecycle.capabilityNodes.awaitingGrant} awaiting grant`}
                  />
                  <LifecycleCard
                    label="bindings"
                    value={lifecycle.bindings.total}
                    detail={`${lifecycle.bindings.ready} ready · ${lifecycle.bindings.drifted} drifted`}
                  />
                  <LifecycleCard
                    label="deliveries"
                    value={lifecycle.deliveries.total}
                    detail={`${lifecycle.deliveries.completed} complete · ${lifecycle.deliveries.degraded} degraded`}
                  />
                </div>
              )}
            </div>
          </section>

          <ProjectCapabilities
            grants={grants}
            projectId={projectId}
            noProject={noProject}
            projectsUnavailable={projectsUnavailable}
            unavailable={unavailable}
            csrfToken={csrfToken}
          />
        </div>
      </div>
    </>
  );
}

function ProjectCapabilities(props: {
  grants: OrgIntegrationSummary[];
  projectId: string;
  noProject: boolean;
  projectsUnavailable: boolean;
  unavailable: boolean;
  csrfToken?: string;
}) {
  return (
    <section class="panel">
      <div class="panel-pad">
        <div class="mini-eyebrow">
          plane b · project enable <span class="window-tag">(sentry · slack · deploy.vercel / deploy.flyio)</span>
        </div>
        {props.projectsUnavailable ? (
          <div class="empty">Capability enable is paused while projects are unavailable.</div>
        ) : props.noProject ? (
          <div class="empty">No project visible yet. Onboard one to enable capabilities against an org grant.</div>
        ) : props.unavailable ? (
          <div class="empty">Capability enable is paused while the org grant list is unavailable.</div>
        ) : (
          <>
            {PROJECT_CAPABILITIES.map((cap) => {
              const linked = isProviderLinked(props.grants, cap.providerKind);
              const selected = props.grants.some(
                (grant) => grant.providerKind === cap.providerKind && grant.selectedForProject,
              );
              return (
                <div class="cap-row" data-capability={cap.capability} data-provider={cap.providerKind}>
                  <span class="glyph">{cap.glyph}</span>
                  <div class="meta">
                    <div class="name">{cap.label}</div>
                    <div class="desc">
                      {cap.capability} → {cap.providerKind}
                    </div>
                  </div>
                  <span class={`state ${selected ? "ready" : "need-link"}`}>
                    {selected ? "account selected" : linked ? "choose account" : "not linked"}
                  </span>
                  {selected ? (
                    <form method="post" action="/integrations/enable">
                      <CsrfField token={props.csrfToken} />
                      <input type="hidden" name="projectId" value={props.projectId} />
                      <input type="hidden" name="capability" value={cap.capability} />
                      <input type="hidden" name="providerKind" value={cap.providerKind} />
                      <button class="btn" type="submit">
                        enable
                      </button>
                    </form>
                  ) : (
                    <button
                      class="btn"
                      type="button"
                      disabled
                      title={linked ? "choose an account above first" : "link provider at org first"}
                    >
                      enable
                    </button>
                  )}
                </div>
              );
            })}
            <div class="note">
              <b>↑ plane b.</b> Enabling a capability provisions or binds a project artifact from the selected org
              grant. A missing link is a structured <b>status: not_linked</b> response, not a fake success.
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function GrantCard(props: { row: OrgIntegrationSummary; projectId: string; csrfToken?: string }) {
  const { row, projectId, csrfToken } = props;
  const active = row.connectionStatus === "active" && row.grantStatus === "active";
  return (
    <div class={`int-card${active ? " linked" : ""}`} data-provider={row.providerKind}>
      <span class="label">{providerLabel(row.providerKind)}</span>
      <span class={`value${active ? "" : " empty"}`}>{statusLabel(row.grantStatus ?? row.connectionStatus)}</span>
      <span class="ref">
        verified principal · {row.displayName} ({row.principalKind})
      </span>
      <span class="sub">health · {statusLabel(row.health)}</span>
      {row.authExpiresAt === undefined ? null : <span class="sub">expires · {row.authExpiresAt}</span>}
      {row.providerScopes.length === 0 ? null : (
        <span class="sub">scopes · {capabilitiesLabel(row.providerScopes)}</span>
      )}
      {row.pendingOperation === undefined ? null : (
        <span class="state need-link" data-pending-operation={row.pendingOperation.status}>
          pending · {row.pendingOperation.stage} ({row.pendingOperation.status})
        </span>
      )}
      {row.selectedForProject ? <span class="state ready">selected for project</span> : null}
      {active &&
      projectId !== "" &&
      !row.selectedForProject &&
      row.grantId !== undefined &&
      row.currentAuthGeneration !== undefined &&
      row.grantGeneration !== undefined ? (
        <form method="post" action="/integrations/select">
          <CsrfField token={csrfToken} />
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="providerKind" value={row.providerKind} />
          <input type="hidden" name="connectionId" value={row.connectionId} />
          <input type="hidden" name="grantId" value={row.grantId} />
          <input type="hidden" name="authGeneration" value={String(row.currentAuthGeneration)} />
          <input type="hidden" name="grantGeneration" value={String(row.grantGeneration)} />
          <button class="btn" type="submit">
            use this principal
          </button>
        </form>
      ) : null}
    </div>
  );
}

function LifecycleCard(props: { label: string; value: number; detail: string }) {
  return (
    <div class="int-card" data-lifecycle-kind={props.label}>
      <span class="label">{props.label}</span>
      <span class="value">{props.value}</span>
      <span class="sub">{props.detail}</span>
    </div>
  );
}

function PrincipalSelectionPanel(props: {
  panel: NonNullable<IntegrationsBodyProps["principalSelection"]>;
  csrfToken?: string;
}) {
  const { panel, csrfToken } = props;
  const status = panel.status ?? "awaiting";
  return (
    <section class="panel" data-principal-selection={panel.operationId} data-principal-status={status}>
      <div class="panel-pad">
        <div class="mini-eyebrow">
          principal selection · {providerLabel(panel.providerKind)}{" "}
          <span class="window-tag">({status} · never guesses)</span>
        </div>
        {status === "failed" ? (
          <div class="notice warn">principal selection failed — re-link the provider with a valid token.</div>
        ) : null}
        {status === "invalidated" ? (
          <div class="notice warn">candidates were invalidated — re-link to refresh verified principals.</div>
        ) : null}
        {status === "unavailable" ? (
          <div class="notice warn">operation unavailable — refresh or re-link to continue principal selection.</div>
        ) : null}
        {status === "completed" ? (
          <div class="notice">principal selection completed for {providerLabel(panel.providerKind)}.</div>
        ) : null}
        {status === "awaiting" || status === "pending" ? (
          <div class="int-grid">
            {panel.candidates.map((candidate) => (
              <form
                class="int-card linked"
                method="post"
                action="/integrations/select-principal"
                data-principal-kind={candidate.principalKind}
              >
                <CsrfField token={csrfToken} />
                <input type="hidden" name="operationId" value={panel.operationId} />
                {/* Hidden exact ID for CSRF form submission only — never visible chrome. */}
                <input type="hidden" name="providerPrincipalId" value={candidate.providerPrincipalId} />
                <span class="label">{candidate.displayName}</span>
                <span class="sub">{candidate.principalKind}</span>
                <button class="btn primary" type="submit">
                  use this principal
                </button>
              </form>
            ))}
          </div>
        ) : null}
        <div class="note">
          <b>↑ multi-principal.</b> Sanitized durable candidates only — no secret refs or generation numbers.
        </div>
      </div>
    </section>
  );
}
