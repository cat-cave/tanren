/**
 * Credentials surface (P2B-0002). Two columns — `org · shared` (billed to org)
 * and `dev · {user}` (billed to the operator) — each listing existing
 * credential REFERENCES (never values) and write-only import forms.
 *
 * Redaction (P2A-0009): no credential value is ever rendered after entry. The
 * list shows ref / kind / scope / created-at only; "view auth.json" surfaces
 * file metadata, not contents. Inputs are write-only and never re-populated.
 */

import type { CredentialRecord } from "../../api/types.js";
import { Field, SelectField } from "./primitives.js";

const API_SCHEMAS: Array<[string, string]> = [
  ["anthropic_v1_messages", "anthropic · v1 messages"],
  ["openai_v1_responses", "openai · v1 responses"],
  ["openai_v1_chat", "openai · v1 chat completions"],
  ["openai_compatible", "openai-compatible"],
  ["custom", "custom"],
];

function kindLabel(kind: CredentialRecord["kind"]): string {
  if (kind === "codex_chatgpt_auth") return "codex chatgpt bundle";
  if (kind === "github_token") return "github token";
  return "api key · opaque";
}

function CredentialRow(props: { record: CredentialRecord; scope: "org" | "me" }) {
  const { record } = props;
  const deleteAction = props.scope === "org" ? "/onboarding/credentials/delete" : undefined;
  return (
    <div class="sunken" style="display:flex;flex-direction:column;gap:6px">
      <div style="display:flex;align-items:center;gap:8px">
        <span class="mono" style="color:var(--fg-1);font-weight:600">
          {kindLabel(record.kind)}
        </span>
        <span class="pill ok" style="margin-left:auto">
          <span class="d"></span>active
        </span>
      </div>
      <div class="mono-dim" style="display:grid;grid-template-columns:72px 1fr;gap:4px">
        <span>ref</span>
        <span class="mono" style="font-size:10px">
          {record.ref}
        </span>
        <span>imported</span>
        <span class="mono" style="font-size:10px">
          {record.createdAt}
        </span>
        <span>value</span>
        <span class="mono" style="font-size:10px;color:var(--fg-3)">
          redacted · never shown (P2A-0009)
        </span>
      </div>
      <div style="display:flex;gap:6px">
        <span class="btn ghost" style="color:var(--ember-08)">
          re-import
        </span>
        <span class="btn ghost" title="metadata only — never contents">
          view metadata
        </span>
        {deleteAction ? (
          <form method="post" action={deleteAction} style="margin-left:auto">
            <input type="hidden" name="ref" value={record.ref} />
            <button type="submit" class="btn danger">
              remove
            </button>
          </form>
        ) : null}
      </div>
    </div>
  );
}

export interface CredentialsBodyProps {
  orgCredentials: CredentialRecord[];
  myCredentials: CredentialRecord[];
  operator: string;
  notice?: string;
}

/** The two-column credentials matrix. Reused by org-setup step 2 + /credentials. */
export function CredentialsBody(props: CredentialsBodyProps) {
  return (
    <>
      {props.notice ? <div class="alert ok">{props.notice}</div> : null}
      <div class="cols-2">
        {/* ── org · shared ────────────────────────────────────────────── */}
        <div class="col-card">
          <div class="h">
            <span>
              org · <em>shared</em>
            </span>
            <span class="mono-dim" style="margin-left:auto">
              billed to org
            </span>
          </div>

          <div class="section-label">▮ api keys · {props.orgCredentials.filter((c) => c.kind === "opaque").length}</div>
          {props.orgCredentials.length === 0 ? (
            <div class="sunken mono-dim">No org credentials yet. Add an API key below.</div>
          ) : (
            props.orgCredentials.map((record) => <CredentialRow record={record} scope="org" />)
          )}

          <form
            class="col-card live"
            method="post"
            action="/onboarding/credentials/org/apikey"
            style="gap:8px;padding:12px"
          >
            <div class="h">+ add api key</div>
            <div class="grid-2">
              <Field name="label" label="label" placeholder='e.g. "anthropic-prod"' required />
              <Field name="baseUrl" label="base url" placeholder="api.anthropic.com" />
            </div>
            <SelectField name="schema" label="api schema" options={API_SCHEMAS} />
            <Field
              name="value"
              label="api key"
              type="password"
              placeholder="sk-… (encrypted to vault, write-only)"
              required
            />
            <div style="display:flex;margin-top:4px">
              <button type="submit" class="btn primary" style="margin-left:auto">
                save key
              </button>
            </div>
          </form>

          <div class="section-label" style="margin-top:4px">
            ▮ github tokens · {props.orgCredentials.filter((c) => c.kind === "github_token").length}
          </div>
          <form
            class="col-card live"
            method="post"
            action="/onboarding/credentials/github"
            style="gap:8px;padding:12px"
          >
            <div class="h">+ import github token</div>
            <Field name="label" label="label" placeholder='e.g. "tanren-bot"' required />
            <Field
              name="token"
              label="token"
              type="password"
              placeholder="ghp_… / github_pat_… (encrypted to vault, write-only)"
              hint="used to publish draft PRs + poll CI · bind it to a project under settings"
              required
            />
            <div style="display:flex;margin-top:4px">
              <button type="submit" class="btn primary" style="margin-left:auto">
                save token
              </button>
            </div>
          </form>
        </div>

        {/* ── dev · {user} ────────────────────────────────────────────── */}
        <div class="col-card">
          <div class="h">
            <span>
              dev · <em>{props.operator}</em>
            </span>
            <span class="mono-dim" style="margin-left:auto">
              billed to you
            </span>
          </div>

          <div class="section-label">▮ agent bundles · {props.myCredentials.length}</div>
          {props.myCredentials.length === 0 ? (
            <div class="sunken mono-dim">No personal bundles yet. Import a Codex bundle below.</div>
          ) : (
            props.myCredentials.map((record) => <CredentialRow record={record} scope="me" />)
          )}

          <form
            class="col-card live"
            method="post"
            action="/onboarding/credentials/dev/codex"
            style="gap:8px;padding:12px"
          >
            <div class="h">+ import codex chatgpt bundle</div>
            <Field name="ref" label="vault ref" placeholder="credential/codex_chatgpt_auth/me/auth" required />
            <div class="field">
              <label for="authJson">auth.json contents</label>
              <textarea
                id="authJson"
                name="authJson"
                placeholder="paste auth.json (write-only · stored in vault · never re-shown)"
                style="font-family:var(--font-mono);font-size:11px;background:var(--bg-canvas);border:1px solid var(--line-1);border-radius:2px;padding:8px;min-height:80px;color:var(--fg-1)"
                required
              ></textarea>
            </div>
            <div style="display:flex;margin-top:4px">
              <button type="submit" class="btn primary" style="margin-left:auto">
                import bundle
              </button>
            </div>
          </form>

          <div class="section-label" style="margin-top:4px">
            ▮ future bundle kinds
          </div>
          <div class="grid-2">
            {[
              ["opencode", "subscription · phase 3"],
              ["claude bundle", "claude code login · phase 3"],
              ["custom", "drop a json file · phase 3"],
            ].map(([name, desc]) => (
              <div class="sunken" style="opacity:0.55">
                <div class="mono" style="font-size:11.5px">
                  {name}
                </div>
                <div class="mono-dim">{desc}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
