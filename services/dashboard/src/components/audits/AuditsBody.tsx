/**
 * P3-0021 scheduled-audits surface (the hi-fi `view-audits` flow). Composes:
 *   - the WHY-SCHEDULE pitch + the window-fill bar (ties to the P3-0018 idle
 *     subscription-cost windows — reads existing data, never invents);
 *   - the AUDIT-JOB library (kind / cadence / target-window / Answerer CLI /
 *     last-run / findings) with a per-job enable toggle + run-now action;
 *   - the FORGE-RECOMMENDED coverage panel (gaps the org isn't yet running);
 *   - the NEW-AUDIT composer.
 *
 * Findings auto-route to the candidate inbox (P3-0022): a run emits each finding
 * into the inbox as a system source, so the footer + the findings cell link to
 * `/inbox`. Every write is a server-side form POST to the audits route; the
 * surface holds no client state of its own.
 */

import type { AuditJob, AuditsSnapshot, AuditKind } from "../../api/auditsTypes.js";
import { PageHead, KpiStrip, relativeTime } from "../project/shared.js";
import { ScreenStyles } from "../project/screenStyles.js";
import { AuditsStyles } from "./auditsStyles.js";
import type { WindowFillColumn } from "./windowFill.js";

const KIND_GLYPH: Record<AuditKind, string> = {
  deps: "⬆",
  security: "⚿",
  a11y: "◍",
  mutation: "⊘",
  perf: "↗",
  license: "§",
  stale_specs: "⌬"
};

const CADENCE_LABEL: Record<string, string> = {
  nightly: "nightly · 03:00",
  weekly: "weekly · sun 04:00",
  monthly: "monthly · 1st 04:00"
};

function WindowFill(props: { columns: WindowFillColumn[] }) {
  if (props.columns.length === 0) return <></>;
  return (
    <div class="window-fill" data-window-fill>
      {props.columns.map((col) => (
        <div class="wf-col">
          <div class="wf-track">
            <div class={`wf-bar ${col.tier}`} style={`height:${Math.max(2, col.pct)}%`}></div>
          </div>
          <div class="wf-pct">{col.pct}%</div>
          <div class="wf-l">{col.label}</div>
        </div>
      ))}
    </div>
  );
}

function WhyAudits(props: { columns: WindowFillColumn[]; lowNames: string[] }) {
  const names = props.lowNames.join(" and ");
  return (
    <div class="why-audits">
      <div class="wtext">
        <div class="wlabel">▮ why schedule audits</div>
        <div class="wbody">
          {props.lowNames.length > 0 ? (
            <>
              Your <b class="bad">{names} window{props.lowNames.length > 1 ? "s sit" : " sits"} under 30% filled</b> — you
              pay for that subscription cap whether you use it or not. Scheduled audits run in those windows: security,
              dependencies, a11y, mutation tests. They cost nothing extra and surface work before it bites.
            </>
          ) : (
            <>
              Your windows are filling well — scheduled audits can still keep paid-for capacity busy through quieter days
              (security, dependencies, a11y, mutation) without raising the cap. Findings become candidates automatically.
            </>
          )}
        </div>
      </div>
      <WindowFill columns={props.columns} />
    </div>
  );
}

function toggleForm(jobId: string, enabled: boolean) {
  const verb = enabled ? "disable" : "enable";
  return (
    <form method="post" action={`/audits/${jobId}/${verb}`} style="display:contents">
      <button class={`btn ${enabled ? "" : "ghost"}`} style="font-size:10px" type="submit" data-action={verb}>
        {enabled ? "on" : "off"}
      </button>
    </form>
  );
}

function AuditRow(props: { job: AuditJob }) {
  const { job } = props;
  const sev = job.enabled ? job.findings.severity : "off";
  const hasFinds = job.findings.count > 0;
  return (
    <div class={`audit-row${job.enabled ? "" : " paused"}`} data-job-id={job.id}>
      <span class="ak">{KIND_GLYPH[job.kind] ?? "▮"}</span>
      <div class="anames">
        <div class="an">{job.name}</div>
        <div class="acli">{job.answererCli || "—"}</div>
      </div>
      <div class="asched">
        <div class="t">{CADENCE_LABEL[job.cadence] ?? job.cadence}</div>
        <div class="w">{job.targetWindow || "—"}</div>
      </div>
      {hasFinds ? (
        <a class={`afind has-finds sev-${sev}`} href="/inbox" data-findings>
          <div class="n">{job.findings.count} found</div>
          <div class="note">{job.findings.note}</div>
        </a>
      ) : (
        <div class={`afind sev-${sev}`} data-findings>
          <div class="n">{job.enabled ? "clean" : "paused"}</div>
          <div class="note">{job.findings.note || (job.enabled ? "no new findings" : "—")}</div>
        </div>
      )}
      <div class="alast">last · {relativeTime(job.lastRun)}</div>
      <div class="row-actions">
        <form method="post" action={`/audits/${job.id}/run`} style="display:contents">
          <button class="btn ghost" style="font-size:10px" type="submit" data-action="run">run now</button>
        </form>
        {toggleForm(job.id, job.enabled)}
      </div>
    </div>
  );
}

function Recommended(props: { snapshot: AuditsSnapshot; orgId: string }) {
  if (props.snapshot.recommended.length === 0) return <></>;
  return (
    <section class="panel" style="padding:14px 16px;gap:10px">
      <div class="sect-label">
        forge recommends · <span style="color:var(--ember-08)">coverage gaps</span>
      </div>
      <div class="audit-rec-grid">
        {props.snapshot.recommended.map((rec) => (
          <div class="audit-rec" data-rec-kind={rec.kind}>
            <div class="rn">+ {rec.name}</div>
            <div class="rw">{rec.why}</div>
            <div class="foot">
              <span class="win">{rec.window}</span>
              <form method="post" action="/audits" style="display:contents">
                <input type="hidden" name="kind" value={rec.kind} />
                <input type="hidden" name="name" value={rec.name} />
                <input type="hidden" name="cadence" value={rec.cadence} />
                <input type="hidden" name="targetWindow" value={rec.window} />
                <button class="btn primary notched" style="font-size:11px" type="submit" data-action="schedule-rec">
                  schedule ↗
                </button>
              </form>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Composer() {
  return (
    <section class="panel" style="padding:14px 16px;gap:12px">
      <div class="sect-label">new scheduled audit</div>
      <form method="post" action="/audits" data-composer>
        <div class="audit-composer">
          <label class="field">
            <span class="label">kind</span>
            <select name="kind" required>
              <option value="security">security scan</option>
              <option value="deps">dependency freshness</option>
              <option value="a11y">accessibility (a11y)</option>
              <option value="mutation">mutation tests</option>
              <option value="perf">performance budget</option>
              <option value="license">license compliance</option>
              <option value="stale_specs">stale-spec sweep</option>
            </select>
          </label>
          <label class="field">
            <span class="label">name</span>
            <input name="name" placeholder="security scan" required />
          </label>
          <label class="field">
            <span class="label">cadence</span>
            <select name="cadence" required>
              <option value="nightly">nightly · 03:00</option>
              <option value="weekly">weekly · sun 04:00</option>
              <option value="monthly">monthly · 1st 04:00</option>
            </select>
          </label>
          <label class="field">
            <span class="label">target window</span>
            <input name="targetWindow" placeholder="night (00–05)" />
          </label>
          <label class="field">
            <span class="label">answerer cli</span>
            <input name="answererCli" placeholder="claude · haiku-4.5" />
          </label>
        </div>
        <div class="composer-actions">
          <button class="btn primary notched" type="submit" data-action="create">create audit ↗</button>
        </div>
      </form>
    </section>
  );
}

export interface AuditsBodyProps {
  orgId: string;
  snapshot: AuditsSnapshot;
  windowColumns: WindowFillColumn[];
  lowNames: string[];
  error?: string;
}

export function AuditsBody(props: AuditsBodyProps) {
  const { jobs } = props.snapshot;
  const active = jobs.filter((j) => j.enabled).length;
  const open = jobs.reduce((sum, j) => sum + (j.enabled ? j.findings.count : 0), 0);
  return (
    <div class="p2b">
      <ScreenStyles />
      <AuditsStyles />
      <PageHead
        eyebrow="▮ automation · scheduled audits"
        title={<>fill the idle <em>windows</em></>}
        sub={<>recurring read-only audit passes · run on a schedule · findings become candidates</>}
        actions={<a class="btn ghost" href="/costs">cost windows ↗</a>}
      />
      <div class="page-body">
        <KpiStrip
          items={[
            { k: "audit jobs", v: String(jobs.length) },
            { k: "active", v: String(active) },
            { k: "open findings", v: String(open), tone: open > 0 ? "hot" : undefined },
            { k: "recommended", v: String(props.snapshot.recommended.length) }
          ]}
        />
        {props.error !== undefined && (
          <div class="placeholder-card" style="border-left:2px solid var(--ember-08)">{props.error}</div>
        )}
        <WhyAudits columns={props.windowColumns} lowNames={props.lowNames} />

        <section class="panel" style="padding:0;overflow:hidden">
          <div class="panel-head">
            <h3>
              audit <em>jobs</em>
            </h3>
            <span class="meta">{active} active · {jobs.length} total</span>
          </div>
          <div class="audit-jobs">
            {jobs.length === 0 && (
              <div class="placeholder-card" style="margin:12px 14px">
                No scheduled audits yet — compose one below or schedule a forge-recommended coverage gap.
              </div>
            )}
            {jobs.map((job) => <AuditRow job={job} />)}
          </div>
          <div class="audit-foot">
            <span style="color:var(--ember-08);margin-right:6px">↑</span>
            audits are Answerers — read-only, no diffs. findings route to the{" "}
            <a href="/inbox">candidate inbox ↗</a> automatically.
          </div>
        </section>

        <Recommended snapshot={props.snapshot} orgId={props.orgId} />
        <Composer />
      </div>
    </div>
  );
}
