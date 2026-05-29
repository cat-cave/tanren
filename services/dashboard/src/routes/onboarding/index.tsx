/**
 * P2B-0002 screen mounts: org-setup wizard (`/onboarding/org`), existing-
 * project minimal link flow (`/onboarding/existing`), the standalone
 * credentials surface (`/onboarding/credentials`), and the notifications
 * matrix (`/notifications`). All render through the P2B-0001 shell via
 * `renderShell`; chrome is untouched.
 *
 * Registered by appending a single line to `SCREEN_MOUNTS` in
 * `src/app/screens.ts`:  `SCREEN_MOUNTS.push(mountOnboardingScreens)`.
 */

import type { Context, Hono } from "hono";
import { OrchestratorClient } from "../../api/orchestrator.js";
import type {
  CredentialRecord,
  DoctorReport,
  NotificationMatrix
} from "../../api/types.js";
import { loadShellContext, renderShell, type ShellDeps } from "../../app/mountShell.js";
import { CredentialsBody } from "../../components/onboarding/CredentialsBody.js";
import { NotificationsBody } from "../../components/onboarding/NotificationsBody.js";
import { OrgWizardBody } from "../../components/onboarding/OrgWizardBody.js";
import { OnbStyles } from "../../components/onboarding/styles.js";
import { mountOnboardingActions } from "./actions.js";
// P3-0016: the brownfield `existing` handlers (5-step full track) live in their
// own module. The shared route file delegates the entire `existing` section to
// it — the org/credentials/notifications handlers below are untouched.
import { mountExistingBrownfield } from "./existing/index.js";

/** The public GitHub App install URL (configurable; sensible default). */
const GITHUB_APP_URL = process.env["TANREN_GITHUB_APP_URL"] ?? "https://github.com/apps/tanren/installations/new";

// P3-0003: when set, the org-setup wizard offers the orchestrator-driven App
// install flow (`/auth/github-app/install?orgId=…`) which provisions an
// auto-rotating installation token. Points at the orchestrator's public URL.
const ORCHESTRATOR_PUBLIC_URL = process.env["TANREN_ORCHESTRATOR_PUBLIC_URL"];

function appInstallHrefFor(orgId: string | undefined): string | undefined {
  if (ORCHESTRATOR_PUBLIC_URL === undefined || ORCHESTRATOR_PUBLIC_URL === "" || orgId === undefined) {
    return undefined;
  }
  return `${ORCHESTRATOR_PUBLIC_URL.replace(/\/$/, "")}/auth/github-app/install?orgId=${encodeURIComponent(orgId)}`;
}

function clientFor(c: Context, deps: ShellDeps): OrchestratorClient {
  return new OrchestratorClient({ orchestratorUrl: deps.orchestratorUrl, cookieHeader: c.req.header("cookie") });
}

function noticeOf(c: Context): string | undefined {
  const notice = c.req.query("notice");
  return notice === undefined || notice === "" ? undefined : notice;
}

export function mountOnboardingScreens(app: Hono, deps: ShellDeps): void {
  mountOnboardingActions(app, deps);
  // P3-0016: brownfield `existing` full track (link → recon → config-injection
  // PR → DAG seed → governance). Owns GET/POST `/onboarding/existing`.
  mountExistingBrownfield(app, deps);

  // ── org-setup wizard ─────────────────────────────────────────────────────
  app.get("/onboarding/org", async (c) => {
    const ctx = await loadShellContext(c, deps, { activeNavId: "onb-org" });
    const client = clientFor(c, deps);
    const orgId = ctx.org?.id;
    const step = Number.parseInt(c.req.query("step") ?? "1", 10) || 1;

    // Only fetch what the active step needs (keeps the page snappy + avoids
    // doctor calls on every step).
    let doctor: DoctorReport | undefined;
    let orgCredentials: CredentialRecord[] = [];
    let myCredentials: CredentialRecord[] = [];
    let matrix: NotificationMatrix = { targets: [], routes: [], events: [] };
    if (step === 1) doctor = await client.doctor();
    if (step === 2 && orgId !== undefined) {
      [orgCredentials, myCredentials] = await Promise.all([
        client.listOrgCredentials(orgId),
        client.listMyCredentials()
      ]);
    }
    if (step === 3 && orgId !== undefined) matrix = await client.notificationMatrix(orgId);

    return renderShell(
      c,
      ctx,
      { title: "tanren · org setup" },
      <>
        <OnbStyles />
        <OrgWizardBody
          step={step}
          orgLogin={ctx.org?.login ?? "your org"}
          githubAppUrl={GITHUB_APP_URL}
          appInstallHref={appInstallHrefFor(orgId)}
          doctor={doctor}
          orgCredentials={orgCredentials}
          myCredentials={myCredentials}
          matrix={matrix}
          operator={ctx.operator}
        />
      </>
    );
  });

  // ── standalone credentials surface ───────────────────────────────────────
  app.get("/onboarding/credentials", async (c) => {
    const ctx = await loadShellContext(c, deps, { activeNavId: "onb-org" });
    const client = clientFor(c, deps);
    const orgId = ctx.org?.id;
    const [orgCredentials, myCredentials] = await Promise.all([
      orgId !== undefined ? client.listOrgCredentials(orgId) : Promise.resolve<CredentialRecord[]>([]),
      client.listMyCredentials()
    ]);
    return renderShell(
      c,
      ctx,
      { title: "tanren · credentials" },
      <>
        <OnbStyles />
        <div class="onb">
          <div class="step-heading">
            <div>
              <div class="eyebrow">credentials · org-shared + dev-personal</div>
              <div class="title">
                api keys and <em>bundles</em>
              </div>
              <div class="sub">secrets are write-only · no credential value is ever rendered after entry (P2A-0009 redaction).</div>
            </div>
          </div>
          <CredentialsBody
            orgCredentials={orgCredentials}
            myCredentials={myCredentials}
            operator={ctx.operator}
            notice={noticeOf(c)}
          />
        </div>
      </>
    );
  });

  // ── notifications matrix ─────────────────────────────────────────────────
  app.get("/notifications", async (c) => {
    const ctx = await loadShellContext(c, deps, { activeNavId: "notifications" });
    const client = clientFor(c, deps);
    const matrix = ctx.org?.id !== undefined
      ? await client.notificationMatrix(ctx.org.id)
      : { targets: [], routes: [], events: [] };
    return renderShell(
      c,
      ctx,
      { title: "tanren · notifications" },
      <>
        <OnbStyles />
        <div class="onb">
          <div class="step-heading">
            <div>
              <div class="eyebrow">notifications · per event × per channel × severity</div>
              <div class="title">
                where should <em>we tell you</em>
              </div>
              <div class="sub">org defaults + dev overrides against the P2A-0017 schema · all channels deliver (configure each channel's credentials).</div>
            </div>
          </div>
          <NotificationsBody matrix={matrix} notice={noticeOf(c)} />
        </div>
      </>
    );
  });

  // The brownfield `existing` flow (GET + link/step POSTs) is owned by
  // `mountExistingBrownfield` (P3-0016, called above) — see ./existing/index.tsx.
}
