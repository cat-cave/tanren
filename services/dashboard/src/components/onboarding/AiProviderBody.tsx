/**
 * "Connect AI provider" surface — the run-default half of credentials.
 * Storing a key (CredentialsBody) never made it the run default; connecting a
 * provider here calls `POST /orgs/:orgId/ai-provider { makeDefault: true }`, which
 * cost-classifies the ref and writes the default LLM routing entry a run resolves,
 * flipping the org's `providerMode → "byok"`.
 *
 * Redaction: secret VALUES are write-only — the connect inputs are never
 * re-populated and the list shows ref / provider / billing class only.
 *
 * NEGATIVE CONTROL: when no run-default provider is wired (providerMode is not
 * "byok", or nothing is marked default), the surface shows a LOUD warning — a run
 * would have no provider to resolve — rather than implying a silent managed
 * fallback.
 */

import type { AiProviderKind, ConnectedProvider } from "../../api/aiProviderClient.js";
import { CsrfField } from "../shell/CsrfField.js";

const PROVIDER_OPTIONS: Array<[AiProviderKind, string]> = [
  ["openrouter", "openrouter · api key"],
  ["anthropic", "anthropic · api key"],
  ["openai", "openai · api key"],
  ["codex", "codex · chatgpt bundle"],
];

export interface AiProviderBodyProps {
  /** Org provider mode ("managed" | "byok"), or undefined when the read failed. */
  providerMode?: string;
  /** Connected providers (values never exposed), or undefined on read failure. */
  providers?: ConnectedProvider[];
  notice?: string;
  csrfToken?: string;
}

function DefaultStatus(props: { providerMode?: string; providers?: ConnectedProvider[] }) {
  if (props.providerMode === undefined || props.providers === undefined) {
    return (
      <div class="alert warn" data-testid="ai-provider-status">
        run-default AI provider status is unavailable — the orchestrator did not answer.
      </div>
    );
  }
  const def = props.providers.find((p) => p.isDefault);
  if (props.providerMode !== "byok" || def === undefined) {
    return (
      <div class="alert warn" data-testid="ai-provider-status" data-ai-provider-no-default>
        no run-default AI provider connected — runs cannot resolve a provider. Connect one below to set the run default
        (no silent managed fallback).
      </div>
    );
  }
  return (
    <div class="alert ok" data-testid="ai-provider-status" data-ai-provider-default={def.ref}>
      run default · <span class="mono">{def.provider}</span> · billed as <span class="mono">{def.classifiedAs}</span>
    </div>
  );
}

function ConnectedRow(props: { record: ConnectedProvider }) {
  const { record } = props;
  return (
    <div class="sunken" style="display:flex;align-items:center;gap:8px" data-ai-provider-row={record.ref}>
      <span class="mono" style="color:var(--fg-1);font-weight:600">
        {record.provider}
      </span>
      <span class="mono-dim" style="font-size:10px">
        {record.classifiedAs}
      </span>
      {record.isDefault ? (
        <span class="pill ok" style="margin-left:auto">
          <span class="d"></span>run default
        </span>
      ) : (
        <span class="mono-dim" style="margin-left:auto;font-size:10px">
          connected
        </span>
      )}
    </div>
  );
}

export function AiProviderBody(props: AiProviderBodyProps) {
  return (
    <div class="col-card" data-screen="ai-provider">
      <div class="h">
        <span>
          connect <em>ai provider</em>
        </span>
        <span class="mono-dim" style="margin-left:auto">
          run default · byok
        </span>
      </div>

      {props.notice ? <div class="alert ok">{props.notice}</div> : null}
      <DefaultStatus providerMode={props.providerMode} providers={props.providers} />

      <div class="section-label">▮ connected providers · {props.providers?.length ?? 0}</div>
      {props.providers === undefined || props.providers.length === 0 ? (
        <div class="sunken mono-dim">No AI provider connected yet. Connect one below to drive runs.</div>
      ) : (
        props.providers.map((record) => <ConnectedRow record={record} />)
      )}

      <form
        class="col-card live"
        method="post"
        action="/onboarding/ai-provider/connect"
        style="gap:8px;padding:12px"
        data-ai-provider-connect
      >
        <CsrfField token={props.csrfToken} />
        <div class="h">+ connect a provider as the run default</div>
        <div class="field">
          <label for="provider">provider</label>
          <select id="provider" name="provider" data-testid="ai-provider-select">
            {PROVIDER_OPTIONS.map(([value, label]) => (
              <option value={value} selected={value === "openrouter"}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div class="field">
          <label for="apiKey">api key · openrouter / anthropic / openai</label>
          <input
            id="apiKey"
            name="apiKey"
            type="password"
            placeholder="sk-… / or-… (encrypted to vault, write-only)"
            autocomplete="off"
            data-testid="ai-provider-api-key"
          />
        </div>
        <div class="field">
          <label for="authJson">auth.json · codex chatgpt bundle only</label>
          <textarea
            id="authJson"
            name="authJson"
            placeholder="paste auth.json ONLY when provider is codex (write-only · stored in vault)"
            style="font-family:var(--font-mono);font-size:11px;background:var(--bg-canvas);border:1px solid var(--line-1);border-radius:2px;padding:8px;min-height:64px;color:var(--fg-1)"
            data-testid="ai-provider-auth-json"
          ></textarea>
        </div>
        <label style="display:flex;align-items:center;gap:6px;font-size:11px">
          <input type="checkbox" name="makeDefault" value="true" checked data-testid="ai-provider-make-default" />
          set as the run default (flips providerMode → byok)
        </label>
        <div style="display:flex;margin-top:4px">
          <button type="submit" class="btn primary" style="margin-left:auto" data-testid="ai-provider-connect-submit">
            connect provider
          </button>
        </div>
      </form>
    </div>
  );
}
