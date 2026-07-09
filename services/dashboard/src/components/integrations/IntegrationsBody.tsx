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

import { LINKABLE_PROVIDER_KINDS, PROJECT_CAPABILITIES, type OrgIntegrationSummary } from "../../api/integrations.js";
import { CsrfField } from "../shell/CsrfField.js";
import { capabilitiesLabel, isProviderLinked, providerLabel, statusLabel } from "./format.js";
import { INTEGRATIONS_SCREEN_CSS } from "./styles.js";

export interface IntegrationsBodyProps {
  /** Org grants, or `undefined` when the list read failed. */
  integrations: OrgIntegrationSummary[] | undefined;
  /** Active project id for Plane-B enable forms (empty when no project). */
  projectId: string;
  /** Project name for the eyebrow scope line. */
  projectName: string;
  /** Whether the operator has a visible project at all. */
  noProject: boolean;
  /** Whether the operator is an org admin (link form write). */
  isOrgAdmin: boolean;
  /** Optional flash from a prior link/enable redirect. */
  notice?: string;
  /**
   * Optional structured not_linked outcome from a prior enable attempt — the
   * 200 path, not an error. Rendered as a link-first affordance.
   */
  notLinked?: { providerKind: string; message?: string };
  /** Session CSRF for pure HTML form posts. */
  csrfToken?: string;
}

export function IntegrationsBody(props: IntegrationsBodyProps) {
  const { integrations, projectId, projectName, noProject, isOrgAdmin, notice, notLinked, csrfToken } = props;
  const unavailable = integrations === undefined;
  const grants = integrations ?? [];

  return (
    <>
      <style data-screen="integrations" dangerouslySetInnerHTML={{ __html: INTEGRATIONS_SCREEN_CSS }} />
      <div class="page-head">
        <div>
          <div class="eyebrow">▮ org · integrations · two-plane · {projectName || "no project"}</div>
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
                    <GrantCard row={row} />
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
                    <label for="token">token (write-only)</label>
                    <input
                      id="token"
                      name="token"
                      type="password"
                      required
                      autocomplete="off"
                      placeholder="provider API token"
                    />
                  </div>
                  <button class="btn primary" type="submit">
                    link
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
                  <b>↑ plane a.</b> The token is stored under a secret REF and never echoed. Metadata values stay
                  server-side; only keys surface on the grant card. Hetzner is out of scope here.
                </div>
              )}
            </div>
          </section>

          {/* ── Plane B: project capabilities ───────────────────────────── */}
          <section class="panel">
            <div class="panel-pad">
              <div class="mini-eyebrow">
                plane b · project enable <span class="window-tag">(sentry · slack · deploy.vercel / deploy.flyio)</span>
              </div>
              {noProject ? (
                <div class="empty">
                  No project visible yet. Onboard one to enable capabilities against an org grant.
                </div>
              ) : unavailable ? (
                <div class="empty">Capability enable is paused while the org grant list is unavailable.</div>
              ) : (
                <>
                  {PROJECT_CAPABILITIES.map((cap) => {
                    const linked = isProviderLinked(grants, cap.providerKind);
                    return (
                      <div class="cap-row" data-capability={cap.capability} data-provider={cap.providerKind}>
                        <span class="glyph">{cap.glyph}</span>
                        <div class="meta">
                          <div class="name">{cap.label}</div>
                          <div class="desc">
                            {cap.capability} → {cap.providerKind}
                          </div>
                        </div>
                        <span class={`state ${linked ? "ready" : "need-link"}`}>
                          {linked ? "linked" : "not linked"}
                        </span>
                        {linked ? (
                          <form method="post" action="/integrations/enable">
                            <CsrfField token={csrfToken} />
                            <input type="hidden" name="projectId" value={projectId} />
                            <input type="hidden" name="capability" value={cap.capability} />
                            <input type="hidden" name="providerKind" value={cap.providerKind} />
                            <button class="btn" type="submit">
                              enable
                            </button>
                          </form>
                        ) : (
                          <button class="btn" type="button" disabled title="link provider at org first">
                            enable
                          </button>
                        )}
                      </div>
                    );
                  })}
                  <div class="note">
                    <b>↑ plane b.</b> Enabling a capability provisions or binds a project artifact from the org grant.
                    If the provider is not linked, the orchestrator returns <b>status: not_linked</b> as a <b>200</b> —
                    link first, do not treat it as an error.
                  </div>
                </>
              )}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

function GrantCard(props: { row: OrgIntegrationSummary }) {
  const { row } = props;
  return (
    <div class={`int-card${row.status === "linked" ? " linked" : ""}`} data-provider={row.providerKind}>
      <span class="label">{providerLabel(row.providerKind)}</span>
      <span class={`value${row.status === "linked" ? "" : " empty"}`}>{statusLabel(row.status)}</span>
      <span class="sub">capabilities · {capabilitiesLabel(row.capabilities)}</span>
      <span class="ref" title="credential ref name only">
        {row.credentialRef}
      </span>
      {row.metadataKeys.length > 0 ? <span class="sub">metadata keys · {row.metadataKeys.join(", ")}</span> : null}
    </div>
  );
}
