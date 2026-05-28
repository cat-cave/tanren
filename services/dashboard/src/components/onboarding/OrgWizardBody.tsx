/**
 * Org-setup wizard (P2B-0002) — the full 4-step track at /onboarding/org:
 *   step 1 · link GitHub org + stack-health (/doctor)
 *   step 2 · credentials (CredentialsBody)
 *   step 3 · notifications matrix (NotificationsBody)
 *   step 4 · infrastructure (local-docker active; cloud allocators stubbed)
 *
 * Rebuilt as TSX from `view-onboard-org.jsx`. Steps are addressable via
 * `?step=N` (resumable deep link); the journey stepper + foot navigate between
 * them. Each step's writes autosave through dashboard-internal POST proxies.
 */

import type { CredentialRecord, DoctorReport, NotificationMatrix } from "../../api/types.js";
import { CredentialsBody } from "./CredentialsBody.js";
import { NotificationsBody } from "./NotificationsBody.js";
import { JourneyStepper, StepHeading, WizardFoot, type WizardStep } from "./primitives.js";

const STEPS: WizardStep[] = [
  { index: 1, label: "link org" },
  { index: 2, label: "credentials" },
  { index: 3, label: "notifications" },
  { index: 4, label: "infrastructure" }
];

const BASE = "/onboarding/org";

function StackHealth(props: { report: DoctorReport | undefined }) {
  if (props.report === undefined) {
    return (
      <div class="col-card" style="gap:8px">
        <div class="h">
          <span>
            stack <em>health</em>
          </span>
          <span class="pill warn" style="margin-left:auto">
            <span class="d"></span>unreachable
          </span>
        </div>
        <div class="alert warn">
          The orchestrator <code>/doctor</code> endpoint is unreachable. Start the stack, then reload —
          this card shows live Postgres / Vault / runner-SSH / runner-image / GitHub checks.
        </div>
      </div>
    );
  }
  const failing = props.report.checks.filter((check) => check.status !== "ok");
  return (
    <div class="col-card" style="gap:8px">
      <div class="h">
        <span>
          stack <em>health</em>
        </span>
        <span class={`pill ${props.report.ok ? "ok" : "warn"}`} style="margin-left:auto">
          <span class="d"></span>
          {props.report.checks.filter((c) => c.status === "ok").length} of {props.report.checks.length} · ok
        </span>
      </div>
      <div class="sunken mono" style="max-height:220px;overflow:auto">
        {props.report.checks.map((check) => (
          <div>
            <span
              style={`margin-right:6px;color:${
                check.status === "ok"
                  ? "var(--status-ok)"
                  : check.status === "warn"
                    ? "var(--status-warn)"
                    : "var(--status-fail)"
              }`}
            >
              {check.status === "ok" ? "✓" : check.status === "warn" ? "!" : "×"}
            </span>
            {check.name} · {check.detail}
            {check.latencyMs !== null ? ` · ${check.latencyMs}ms` : ""}
          </div>
        ))}
      </div>
      {failing.length > 0 ? (
        <div class="alert fail">
          {failing.length} check{failing.length === 1 ? "" : "s"} need attention. Operator actions:
          <ul style="margin:6px 0 0;padding-left:18px">
            {failing.map((check) => (
              <li>
                <b>{check.name}</b>:{" "}
                {check.name.includes("postgres")
                  ? "verify the db container is up (`just up`) and migrations ran."
                  : check.name.includes("vault")
                    ? "unseal Vault / check VAULT_ADDR + token."
                    : check.name.includes("runner")
                      ? "confirm runner SSH reachability + the runner image is pulled."
                      : check.name.includes("github")
                        ? "check the GitHub App token and network egress."
                        : "see /doctor detail above."}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div class="mono-dim">
          ↗ accessible forever at <code style="color:var(--ember-07)">/doctor</code> · re-runs on demand
        </div>
      )}
    </div>
  );
}

function Step1LinkOrg(props: { orgLogin: string; report: DoctorReport | undefined; githubAppUrl: string; appInstallHref?: string }) {
  const scopes: Array<[string, string, boolean]> = [
    ["▸", "read · contents, metadata, issues, prs · selected repos only", true],
    ["▸", "write · create branches, prs, comments, issues", true],
    ["▸", "read · org members (for review-gate routing)", true],
    ["▸", "read · ci / check status", true],
    ["×", "never · push directly to default branches", false],
    ["×", "never · admin · billing · secrets", false]
  ];
  return (
    <>
      <StepHeading
        eyebrow="step 1 · link tanren to your github org"
        title="give tanren access"
        em="to the org"
        sub={`once authorized on ${props.orgLogin}, that pick decides which repos tanren can ever touch. your github org is your tanren org.`}
      />
      <div class="cols-2-1">
        <div class="col-card">
          <div class="h">
            <span>
              authorize on <em>{props.orgLogin}</em>
            </span>
            <span class="pill ok" style="margin-left:auto">
              <span class="d"></span>one-time setup
            </span>
          </div>
          <div class="alert ok" style="display:flex;align-items:center;gap:12px">
            <span style="font-family:var(--font-jp);font-size:24px;color:var(--ember-08)">鍛</span>
            <div style="flex:1">
              authorize <b>tanren</b> on {props.orgLogin} · one-time · editable later
            </div>
            {props.appInstallHref !== undefined ? (
              <a class="btn primary" href={props.appInstallHref}>
                install github app ↗
              </a>
            ) : (
              <a class="btn primary" href={props.githubAppUrl} target="_blank" rel="noreferrer">
                open github ↗
              </a>
            )}
          </div>
          {props.appInstallHref !== undefined ? (
            <div class="sub" style="margin-top:6px">
              installs the tanren github app on {props.orgLogin} · uses auto-rotating installation tokens (no static pat to manage).
            </div>
          ) : null}
          <div class="sunken">
            <div class="section-label" style="margin-bottom:6px">
              what tanren will ask for
            </div>
            <ul class="scope-list">
              {scopes.map(([glyph, text, asks]) => (
                <li class={asks ? "" : "never"}>
                  <span class="g" style={asks ? "color:var(--ember-08)" : "color:var(--fg-3)"}>
                    {glyph}
                  </span>
                  {text}
                </li>
              ))}
            </ul>
          </div>
        </div>
        <StackHealth report={props.report} />
      </div>
    </>
  );
}

function CloudAllocatorStub(props: { name: string; desc: string; glyph: string; price: string }) {
  return (
    <div class="sunken" style="display:grid;grid-template-columns:auto 1fr auto auto;gap:12px;align-items:center;opacity:0.7">
      <div style="width:26px;height:26px;border:1px solid var(--line-2);display:flex;align-items:center;justify-content:center;font-family:var(--font-mono)">
        {props.glyph}
      </div>
      <div>
        <div class="display-h" style="font-size:13px">
          {props.name}
        </div>
        <div class="mono-dim">{props.desc}</div>
      </div>
      <span class="mono-dim">{props.price}</span>
      <span class="phase-badge phase-p4">phase 4+</span>
    </div>
  );
}

function Step4Infra(props: { orgLogin: string }) {
  return (
    <>
      <StepHeading
        eyebrow="step 4 · runner infrastructure"
        title="where do the"
        em="forges burn"
        sub="every spec runs in an isolated container. local-docker is the only v0-active allocator; cloud allocators scale beyond one laptop in a later phase."
      />
      <div class="cols-2-1">
        <div class="col-card">
          <div class="h">
            <span>allocators</span>
            <span class="mono-dim" style="margin-left:auto">
              org default · per-project overridable
            </span>
          </div>
          <form class="col-card live" method="post" action="/onboarding/org/infra" style="gap:10px;position:relative">
            <span class="phase-badge phase-v0" style="position:absolute;top:-8px;right:12px">
              active default
            </span>
            <div class="display-h">
              local <em>docker</em>
            </div>
            <div class="mono-dim">spawns runner containers on the docker host that runs tanren itself · zero infra cost</div>
            <div class="grid-2">
              <div class="field">
                <label for="concurrency">concurrency</label>
                <input id="concurrency" name="concurrency" value="3" autocomplete="off" />
              </div>
              <div class="field">
                <label for="runnerImage">runner image</label>
                <input id="runnerImage" name="runnerImage" value="tanren-runner" autocomplete="off" />
              </div>
              <div class="field">
                <label for="memoryGb">memory (gb)</label>
                <input id="memoryGb" name="memoryGb" value="4" autocomplete="off" />
              </div>
              <div class="field">
                <label for="cpus">cpus</label>
                <input id="cpus" name="cpus" value="2" autocomplete="off" />
              </div>
            </div>
            <div style="display:flex">
              <button type="submit" class="btn primary" style="margin-left:auto">
                save defaults
              </button>
            </div>
          </form>

          <div class="section-label" style="margin-top:6px">
            cloud allocators · scale beyond your laptop
          </div>
          <CloudAllocatorStub name="hetzner cloud" desc="cheapest hourly · cax21 default" glyph="⌬" price="€0.005/h" />
          <CloudAllocatorStub name="digitalocean" desc="global droplets · 2gb baseline" glyph="◐" price="$0.012/h" />
          <CloudAllocatorStub name="aws ec2" desc="spot fleet · vpc + iam required" glyph="⌖" price="$0.008/h" />
          <CloudAllocatorStub name="kubernetes pool" desc="bring-your-own cluster" glyph="◇" price="byo cost" />
        </div>

        <div style="display:flex;flex-direction:column;gap:12px">
          <div class="col-card" style="gap:8px">
            <div class="h">
              <span>
                budgets <em>(reminder)</em>
              </span>
              <span class="mono-dim" style="margin-left:auto">
                edit at /settings/budgets
              </span>
            </div>
            <div class="grid-2">
              <div class="sunken">
                <div class="section-label">monthly cap</div>
                <div class="mono" style="font-size:20px;margin-top:2px">
                  $200
                </div>
              </div>
              <div class="sunken">
                <div class="section-label">infra portion</div>
                <div class="mono" style="font-size:20px;margin-top:2px">
                  $0 · local
                </div>
              </div>
            </div>
          </div>
          <div class="sunken" style="border-left:2px solid var(--steel-08)">
            <div class="section-label" style="color:var(--steel-08)">
              label → allocator routing
            </div>
            <div class="mono-dim" style="margin-top:4px">
              spec labels pick the allocator at run-time. <span class="phase-badge phase-p3">phase 3+</span>
            </div>
          </div>
          <div class="arrival-card">
            <div class="kanji-bg">鍛</div>
            <div class="eyebrow">{props.orgLogin} · ready</div>
            <div class="display">org is forged.</div>
            <div class="actions">
              <a class="btn primary" href="/onboarding/existing">
                connect a repo ↗
              </a>
              <a class="btn" href="/onboarding/new">
                start a new repo
              </a>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

export interface OrgWizardBodyProps {
  step: number;
  orgLogin: string;
  githubAppUrl: string;
  doctor: DoctorReport | undefined;
  orgCredentials: CredentialRecord[];
  myCredentials: CredentialRecord[];
  matrix: NotificationMatrix;
  operator: string;
  /** P3-0003: orchestrator install-flow href (`/auth/github-app/install?orgId=…`). */
  appInstallHref?: string;
}

export function OrgWizardBody(props: OrgWizardBodyProps) {
  const step = Math.max(1, Math.min(4, props.step));
  const foot = footFor(step);
  return (
    <div class="onb">
      <JourneyStepper steps={STEPS} current={step} basePath={BASE} />
      {step === 1 ? (
        <Step1LinkOrg orgLogin={props.orgLogin} report={props.doctor} githubAppUrl={props.githubAppUrl} appInstallHref={props.appInstallHref} />
      ) : step === 2 ? (
        <>
          <StepHeading
            eyebrow="step 2 · credentials · generic, role-blind"
            title="api keys and"
            em="bundles"
            sub="we store credentials. routing rules in /settings decide which key gets which job. secrets are write-only — never re-shown after entry."
          />
          <CredentialsBody
            orgCredentials={props.orgCredentials}
            myCredentials={props.myCredentials}
            operator={props.operator}
          />
        </>
      ) : step === 3 ? (
        <>
          <StepHeading
            eyebrow="step 3 · notifications"
            title="where should"
            em="we tell you"
            sub="multi-channel routing per event. set the org defaults; devs layer personal overrides. only ntfy delivers in v0."
          />
          <NotificationsBody matrix={props.matrix} />
        </>
      ) : (
        <Step4Infra orgLogin={props.orgLogin} />
      )}
      <WizardFoot
        backHref={step > 1 ? `${BASE}?step=${step - 1}` : undefined}
        backLabel={step > 1 ? `back · ${STEPS[step - 2]?.label}` : undefined}
        hint={foot.hint}
        primaryHref={foot.primaryHref}
        primaryLabel={foot.primaryLabel}
      />
    </div>
  );
}

function footFor(step: number): { hint: string; primaryHref: string; primaryLabel: string } {
  if (step === 4) {
    return { hint: "↑ allocators editable from /settings/infrastructure", primaryHref: "/onboarding/existing", primaryLabel: "finish · connect a repo" };
  }
  const hints = [
    "↑ this page is the audit root — every action tanren can take is listed above",
    "↑ no roles assigned here · /settings/routing decides which key answers each loop phase",
    "↑ devs can override these per channel in /notifications"
  ];
  return { hint: hints[step - 1] ?? "", primaryHref: `${BASE}?step=${step + 1}`, primaryLabel: `next · ${STEPS[step]?.label}` };
}
