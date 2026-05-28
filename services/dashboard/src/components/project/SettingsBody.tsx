/**
 * Routing & limits settings (P2B-0003). Renders the 6-role fallback-chain
 * editor, the Vault per-cred policy panel (read-only), the escape-hatches
 * editor, and the conditional audit-gate caption — all generated from the
 * P2A-0006 routing schema (`RoutingTable` / `EscapeHatches`). v0 ships only
 * functional Codex bindings, but the editor handles 1..N-entry chains for
 * every role and any provider the schema accepts.
 *
 * Mutations are server-side form POSTs to this spec's own settings routes
 * (add / remove / reorder a chain entry; save escape hatches). Each POST loads
 * the merged config, applies the edit, and PATCHes it back via P2A-0013 (which
 * delegates to P2A-0006). No PR is opened — the audit-gate caption defaults to
 * the "edits land in the dashboard" state in Phase 2.
 */

import {
  ROLE_IDS,
  type CredentialRecord,
  type EscapeHatches,
  type ProjectSummary,
  type RoleId,
  type RoutingTable
} from "../../api/types.js";
import { ScreenStyles } from "./screenStyles.js";
import { PageHead } from "./shared.js";

/** Responsibility text per role, surfaced in each role header (hi-fi copy). */
export const ROLE_DESCRIPTIONS: Record<RoleId, string> = {
  plan: "spec → ordered subtasks · runs once per loop",
  write: "writer subtasks · heaviest spend · longest fallback ok",
  check: "verify per-subtask · cheap model preferred",
  audit: "spec-level verdict · strongest reasoning model · no dev bundles",
  demo: "spec-completion narration for review · cheap, optional",
  forge: "read-only narration with operator write-buttons · config edits land via this surface"
};

/** Default escape-hatch values (P2A-0006 schema defaults) shown as the diff cue. */
export const ESCAPE_HATCH_DEFAULTS: EscapeHatches = {
  maxWriterIterPerSubtask: 5,
  maxPlannerRerunsPerSpec: 3,
  maxRetriesPerTransientFailure: 3,
  maxSpecDiscoveryRoundsWithForge: 20
};

interface VaultEntry {
  label: string;
  path: string;
  policy: string;
  detail: string;
}

/**
 * Vault per-cred policy display. Phase-2 v0 surfaces the Codex session-cookie
 * entry as the wired credential; other rows describe their rotation policy.
 * Read-only — no values rendered (only paths + policy). Phase 3 reads these
 * from the live Vault policy API.
 */
const VAULT_ENTRIES: VaultEntry[] = [
  {
    label: "codex chatgpt bundle",
    path: "vault://dev/codex/chatgpt",
    policy: "auto-refresh on use",
    detail: "session cookie refreshes on each runner launch · no manual rotation needed"
  },
  {
    label: "github app",
    path: "vault://org/github/app",
    policy: "auto · jwt + installation token",
    detail: "short-lived tokens minted per call · jwt rotates yearly"
  }
];

export interface SettingsBodyProps {
  project: ProjectSummary;
  routing: RoutingTable;
  escapeHatches: EscapeHatches;
  orgId: string;
  /** Org audit-gate flag. Phase 2 default is off (edits land in DB). */
  auditGate: boolean;
  /** True after a successful save; renders the saved banner. */
  saved?: boolean;
  /** Org-scoped credential refs (P3-0002), used to populate the binding dropdowns. */
  orgCredentials?: CredentialRecord[];
  /** The project's currently-bound credential refs (P3-0002). */
  boundCredentials?: { codexCredentialRef?: string; githubCredentialRef?: string };
}

export function SettingsBody(props: SettingsBodyProps) {
  return (
    <div class="p2b">
      <ScreenStyles />
      <PageHead
        eyebrow="▮ settings · routing & limits"
        title={
          <>
            routing, fallbacks, <em>escape hatches</em>
          </>
        }
        sub={
          props.auditGate
            ? <>config committed via pr · forge can edit</>
            : <>{props.project.name} · routing &amp; limits · stored in dashboard</>
        }
      />
      <div class="page-body">
        {props.saved === true && <div class="form-ok">configuration saved · applies to the next live run</div>}
        <div class="settings-grid">
          <div>
            <RoutingPanel {...props} />
          </div>
          <div>
            <VaultPanel />
          </div>
        </div>
        <CredentialsPanel {...props} />
        <EscapeHatchesPanel {...props} />
        <AuditGatePanel {...props} />
      </div>
    </div>
  );
}

function RoutingPanel(props: SettingsBodyProps) {
  return (
    <div class="panel">
      <div class="panel-head">
        <h3>
          routing · <em>role → fallback chain</em>
        </h3>
        <span class="meta">(cli · model · auth) tuples · reorder &amp; add fallbacks</span>
      </div>
      <div class="panel-body">
        {ROLE_IDS.map((role) => (
          <RoleRow role={role} chain={props.routing[role]?.chain ?? []} orgId={props.orgId} projectId={props.project.projectId} />
        ))}
        <div class="audit-caption" style="margin-top:8px">
          ↑ auth refs point at vault entries from org setup · only codex bindings function in v0
        </div>
      </div>
    </div>
  );
}

function RoleRow(props: {
  role: RoleId;
  chain: { cli: string; model: string; authRef: string; healthHint?: string }[];
  orgId: string;
  projectId: string;
}) {
  const base = `/settings/routing/${props.projectId}`;
  return (
    <div class="routing-role">
      <div class="role-head">
        <span class="role">▸ {props.role}</span>
        <span class="desc">{ROLE_DESCRIPTIONS[props.role]}</span>
      </div>
      {props.chain.length === 0 ? (
        <div class="empty-note">no entries · falls back to org default · add a codex binding below</div>
      ) : (
        props.chain.map((entry, index) => (
          <div class={`routing-row${index === 0 ? " first" : ""}`}>
            <span class="rank">{index === 0 ? "preferred" : `↓ ${index + 1}`}</span>
            <span class="cli">{entry.cli}</span>
            <span class="model">{entry.model}</span>
            <span class="auth">{entry.authRef}</span>
            <span class={`health ${entry.healthHint ?? "ok"}`}>
              {entry.healthHint === "rate_limited" ? "rate-limited" : entry.healthHint ?? "ok"}
            </span>
            <span class="acts">
              {index > 0 && (
                <form method="post" action={`${base}/reorder`}>
                  <input type="hidden" name="orgId" value={props.orgId} />
                  <input type="hidden" name="role" value={props.role} />
                  <input type="hidden" name="index" value={String(index)} />
                  <input type="hidden" name="direction" value="up" />
                  <button type="submit" title="move up">↑</button>
                </form>
              )}
              {index < props.chain.length - 1 && (
                <form method="post" action={`${base}/reorder`}>
                  <input type="hidden" name="orgId" value={props.orgId} />
                  <input type="hidden" name="role" value={props.role} />
                  <input type="hidden" name="index" value={String(index)} />
                  <input type="hidden" name="direction" value="down" />
                  <button type="submit" title="move down">↓</button>
                </form>
              )}
              <form method="post" action={`${base}/remove`}>
                <input type="hidden" name="orgId" value={props.orgId} />
                <input type="hidden" name="role" value={props.role} />
                <input type="hidden" name="index" value={String(index)} />
                <button type="submit" title="remove">×</button>
              </form>
            </span>
          </div>
        ))
      )}
      <form class="add-fallback" method="post" action={`${base}/add`}>
        <input type="hidden" name="orgId" value={props.orgId} />
        <input type="hidden" name="role" value={props.role} />
        <input type="text" name="cli" placeholder="cli (e.g. codex)" required />
        <input type="text" name="model" placeholder="model (e.g. gpt-5.5)" required />
        <input type="text" name="authRef" placeholder="auth ref (vault://…)" required />
        <button type="submit">+ add fallback</button>
      </form>
    </div>
  );
}

function VaultPanel() {
  return (
    <div class="panel">
      <div class="panel-head">
        <h3>
          vault · <em>per-cred policy</em>
        </h3>
        <span class="meta">rotation is contextual · no values rendered</span>
      </div>
      <div class="panel-body">
        {VAULT_ENTRIES.map((entry) => (
          <div class="vault-card">
            <div class="top">
              <span class="label">{entry.label}</span>
              <span class="state">ok</span>
            </div>
            <div class="path">{entry.path}</div>
            <div class="policy">↻ {entry.policy}</div>
            <div class="detail">{entry.detail}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Credentials binding (P3-0002). Two dropdowns — Codex + GitHub — populated
 * from the org's credential REFERENCES (never values), persisting the chosen
 * refs into project config via the settings PATCH path. An empty selection
 * clears the binding so the run falls back to the org default. No secret value
 * is ever rendered — only the ref string + kind.
 */
function CredentialsPanel(props: SettingsBodyProps) {
  const records = props.orgCredentials ?? [];
  const codexOptions = records.filter((r) => r.kind === "codex_chatgpt_auth");
  const githubOptions = records.filter((r) => r.kind === "github_token");
  return (
    <div class="panel" style="margin-top:14px">
      <div class="panel-head">
        <h3>
          credentials · <em>codex + github binding</em>
        </h3>
        <span class="meta">refs only · no values · empty = inherit org default</span>
      </div>
      <div class="panel-body">
        <div class="audit-caption" style="margin-bottom:8px">
          bind the run's codex bundle + github token · import new ones under{" "}
          <a href="/onboarding/credentials">credentials ↗</a>
        </div>
        <form method="post" action={`/settings/routing/${props.project.projectId}/credentials`}>
          <input type="hidden" name="orgId" value={props.orgId} />
          <div class="settings-grid">
            <CredentialSelect
              name="codexCredentialRef"
              label="codex bundle"
              options={codexOptions}
              selected={props.boundCredentials?.codexCredentialRef}
              emptyNote="no codex bundles in this org yet"
            />
            <CredentialSelect
              name="githubCredentialRef"
              label="github token"
              options={githubOptions}
              selected={props.boundCredentials?.githubCredentialRef}
              emptyNote="no github tokens in this org yet"
            />
          </div>
          <div class="head-actions" style="margin-top:12px">
            <button class="btn primary" type="submit">
              save credentials
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function CredentialSelect(props: {
  name: string;
  label: string;
  options: CredentialRecord[];
  selected?: string;
  emptyNote: string;
}) {
  return (
    <div class="field">
      <label for={props.name}>{props.label}</label>
      <select id={props.name} name={props.name}>
        <option value="" selected={props.selected === undefined || props.selected === ""}>
          — inherit org default —
        </option>
        {props.options.map((record) => (
          <option value={record.ref} selected={record.ref === props.selected}>
            {record.ref}
          </option>
        ))}
      </select>
      {props.options.length === 0 ? <div class="audit-caption">{props.emptyNote}</div> : null}
    </div>
  );
}

interface HatchCard {
  field: keyof EscapeHatches;
  label: string;
  onExceed: string;
  stub?: boolean;
}

const HATCH_CARDS: HatchCard[] = [
  { field: "maxWriterIterPerSubtask", label: "max writer iter per subtask", onExceed: "→ escalate to operator (halt)" },
  { field: "maxPlannerRerunsPerSpec", label: "max planner re-runs per spec", onExceed: "→ revise spec (halt)" },
  { field: "maxRetriesPerTransientFailure", label: "max retries per task on transient fail", onExceed: "→ try next fallback in chain" },
  { field: "maxSpecDiscoveryRoundsWithForge", label: "max spec-discovery rounds with forge", onExceed: "→ checkpoint · resume later", stub: true }
];

function EscapeHatchesPanel(props: SettingsBodyProps) {
  return (
    <div class="panel">
      <div class="panel-head">
        <h3>
          escape hatches · <em>not perf budgets</em>
        </h3>
        <span class="meta">limits exist to stop runaway loops · save applies to the next run</span>
      </div>
      <div class="panel-body">
        <div class="escape-note">
          tanren's leverage is parallel dag execution. don't squeeze individual specs for speed — these limits
          exist to stop runaway loops, nothing else. <b>not configured here:</b> per-task time limits · per-spec
          wallclock caps. the escape hatch is the count, not the clock.
        </div>
        <form method="post" action={`/settings/routing/${props.project.projectId}/hatches`}>
          <input type="hidden" name="orgId" value={props.orgId} />
          <div class="hatch-grid">
            {HATCH_CARDS.map((card) => {
              const current = props.escapeHatches[card.field];
              const isDefault = current === ESCAPE_HATCH_DEFAULTS[card.field];
              return (
                <div class={`hatch-card${card.stub ? " stub" : ""}`}>
                  <div class="l">
                    {card.label}
                    {card.stub === true && <span class="badge"> phase 3 stub</span>}
                  </div>
                  <input type="number" name={card.field} value={String(current)} min="0" disabled={card.stub === true} />
                  <div class="prev">
                    {isDefault ? "default" : `was ${ESCAPE_HATCH_DEFAULTS[card.field]} (default)`}
                  </div>
                  <div class="t">{card.onExceed}</div>
                </div>
              );
            })}
          </div>
          <div class="head-actions" style="margin-top:12px">
            <button class="btn primary" type="submit">
              save escape hatches
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * The "tell forge to change config" panel. The caption is conditional on the
 * org audit-gate flag: on → "edits land as a pr in <org>/tanren-config"; off
 * (Phase 2 default) → "edits land in the dashboard · no PR required". The
 * audit-gate toggle itself is hidden in v0. The natural-language input is a
 * stub (full Forge config-edit PRs are Phase 3).
 */
function AuditGatePanel(props: SettingsBodyProps) {
  return (
    <div class="forge-card" style="margin-top:14px">
      <div class="forge-input" style="border-top:none">
        <span class="stamp">鍛</span>
        <input placeholder={`"swap audit primary to a different cli" · "raise max writer iter to 8"`} disabled />
        <span class="kbd">↵</span>
      </div>
      <div class="panel-body" style="padding-top:0">
        {props.auditGate ? (
          <div class="audit-caption">
            edits land as a pr in <code>{props.project.name}/tanren-config</code> · review before merge
          </div>
        ) : (
          <div class="audit-caption">edits land in the dashboard · no pr required (audit gate off · phase 2 default)</div>
        )}
      </div>
    </div>
  );
}
