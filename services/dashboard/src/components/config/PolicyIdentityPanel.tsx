/**
 * gv-3 — visible receipt of the active project's governance policy content hash.
 * Failures are actionable (denied / missing / malformed / unavailable).
 */

import type { PolicyIdentityReadResult } from "../../api/policyIdentityClient.js";

export interface PolicyIdentityPanelProps {
  projectId: string | undefined;
  projectName: string | undefined;
  result: PolicyIdentityReadResult | undefined;
}

export function PolicyIdentityPanel(props: PolicyIdentityPanelProps) {
  return (
    <section class="policy-identity" data-proof="gv3_policy_identity_receipt">
      <h3>
        policy identity <em>gv-3</em>
      </h3>
      <p class="sub">
        Content hash MergeAuthority stamps on land bindings — never the schema literal <code>version: 1</code>.
      </p>
      {panelBody(props)}
      <style>{POLICY_IDENTITY_CSS}</style>
    </section>
  );
}

function panelBody(props: PolicyIdentityPanelProps) {
  if (props.projectId === undefined || props.projectName === undefined) {
    return <div class="form-warn">No project visible — onboard one to inspect its policy identity.</div>;
  }
  if (props.result === undefined) {
    return <div class="form-warn">Policy identity not loaded for {props.projectName}.</div>;
  }
  if (props.result.ok) {
    return (
      <div class="receipt">
        <div class="row">
          <span class="k">project</span>
          <span class="v">
            {props.projectName} <code>{props.projectId}</code>
          </span>
        </div>
        <div class="row">
          <span class="k">policy hash</span>
          <span class="v mono" data-testid="policy-hash">
            {props.result.view.policyHash}
          </span>
        </div>
        <div class="row">
          <span class="k">fields</span>
          <span class="v">{props.result.view.fields.join(" · ")}</span>
        </div>
        <div class="row">
          <span class="k">proof</span>
          <span class="v">{props.result.view.proof}</span>
        </div>
      </div>
    );
  }
  return (
    <div class="form-err" role="alert">
      {errorMessage(props.result.reason, props.projectName)}
    </div>
  );
}

function errorMessage(
  reason: "denied" | "not_found" | "unreadable" | "malformed" | "unavailable",
  projectName: string,
): string {
  switch (reason) {
    case "denied":
      return `Access denied reading policy identity for ${projectName}.`;
    case "not_found":
      return `Project ${projectName} was not found for this org.`;
    case "unreadable":
      return `Project config for ${projectName} is unreadable — fix the stored config.`;
    case "malformed":
      return `Policy identity response for ${projectName} failed validation — refuse to display.`;
    case "unavailable":
      return `Could not reach the orchestrator for ${projectName} policy identity.`;
    default:
      return `Unknown policy identity error for ${projectName}: ${String(reason satisfies never)}`;
  }
}

const POLICY_IDENTITY_CSS = `
.policy-identity { margin-top: 28px; padding-top: 20px; border-top: 1px solid var(--line, #2a2a2a); }
.policy-identity h3 { font-size: 14px; font-weight: 600; margin: 0 0 6px; }
.policy-identity h3 em { font-style: normal; color: var(--ember-08, #c4a574); }
.policy-identity .sub { font-size: 12px; color: var(--ink-soft, #888); margin: 0 0 12px; }
.policy-identity .receipt { display: grid; gap: 8px; font-size: 12px; }
.policy-identity .row { display: grid; grid-template-columns: 110px 1fr; gap: 8px; }
.policy-identity .k { color: var(--ink-soft, #888); text-transform: lowercase; }
.policy-identity .v.mono, .policy-identity code { font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px; word-break: break-all; }
.policy-identity .form-err { color: var(--danger, #e85d5d); font-size: 12px; }
.policy-identity .form-warn { color: var(--ink-soft, #888); font-size: 12px; }
`;
