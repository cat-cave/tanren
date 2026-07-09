/**
 * Org Overview command deck body — projects grid, portfolio budget (gated
 * spend), forge-org card (honest empty: no org-wide forge API yet),
 * cross-project activity feed.
 *
 * Presentation only. Uncomputable → "—"; read failure → unavailable / empty /
 * partial warning. Never fabricates zeros, org-wide caps, or project status.
 */

import type { ProjectSummary } from "../../api/types.js";
import {
  activityKind,
  budgetUsd,
  capBarWidth,
  humanizeEvent,
  percentOfCap,
  relativeCompact,
  type OrgMtdBudget,
} from "./format.js";
import { OVERVIEW_SCREEN_CSS } from "./styles.js";

/** One activity row after project-name join + sort. */
export interface OverviewActivityItem {
  ts: string;
  projectId: string;
  projectName: string;
  runId: string;
  eventType: string;
  specId: string | null;
}

export interface OverviewBodyProps {
  orgLogin: string;
  projects: ProjectSummary[];
  /** True when the projects list read failed (not an honest empty portfolio). */
  projectsUnavailable: boolean;
  /**
   * Aggregated portfolio budget, or `undefined` when org + every project budget
   * read failed (full unavailable).
   */
  mtd: OrgMtdBudget | undefined;
  /** Whether the org default budget endpoint itself failed. */
  orgBudgetUnavailable: boolean;
  /**
   * Cross-project feed rows (already sorted newest-first). Empty array is a
   * real empty feed; the route does not invent rows on failure.
   */
  activity: OverviewActivityItem[];
  /** True when every per-project feed read failed (vs empty success). */
  activityUnavailable: boolean;
  /** Count of project feeds that failed while others succeeded (partial). */
  activityFailedReads: number;
  /** Optional fixed "now" for relative timestamps in tests. */
  now?: Date;
}

function isEmpty(value: string): boolean {
  return value === "—";
}

function ProjectTile(props: { project: ProjectSummary }) {
  const { project } = props;
  const branch = project.defaultBranch === null || project.defaultBranch === "" ? "—" : project.defaultBranch;
  const allocator = project.allocator === null || project.allocator === "" ? "—" : project.allocator;
  return (
    <a
      class="proj-tile"
      href={`/projects/${encodeURIComponent(project.projectId)}`}
      data-project-id={project.projectId}
    >
      <div class="name-row">
        <div class="name">{project.name}</div>
      </div>
      <div class="repo" title={project.repoUrl}>
        {project.repoUrl}
      </div>
      <div class="meta-row">
        <span>
          branch · <b>{branch}</b>
        </span>
        <span>
          allocator · <b>{allocator}</b>
        </span>
      </div>
    </a>
  );
}

function BudgetCard(props: { mtd: OrgMtdBudget | undefined; orgBudgetUnavailable: boolean }) {
  const { mtd, orgBudgetUnavailable } = props;

  if (mtd === undefined) {
    return (
      <div class="col-card" data-budget-card>
        <div class="h">
          <span>
            budget · <em>gated spend</em>
          </span>
        </div>
        <div class="empty" data-budget-unavailable>
          Budget unavailable — org and project budget reads failed. No spend is fabricated.
        </div>
        <a class="link-out" href="/budget">
          budget panel ↗
        </a>
      </div>
    );
  }

  const spentLabel = mtd.spentUsd === undefined ? "—" : budgetUsd(mtd.spentUsd);
  // Portfolio denominator = sum of resolved project ceilings (NOT org default).
  const portfolioCapLabel = mtd.projectCeilingsSumUsd === undefined ? "—" : budgetUsd(mtd.projectCeilingsSumUsd);
  const orgDefaultLabel = budgetUsd(mtd.orgDefaultCeilingUsd);
  const pct = percentOfCap(mtd.spentUsd, mtd.projectCeilingsSumUsd);
  const bar = capBarWidth(mtd.spentUsd, mtd.projectCeilingsSumUsd);
  const period = mtd.spendPeriodLabel === "—" || mtd.spendPeriodLabel === "" ? "period" : mtd.spendPeriodLabel;

  return (
    <div class="col-card" data-budget-card>
      <div class="h">
        <span>
          budget · <em>gated spend</em>
        </span>
        <span class="meta">{period}</span>
      </div>
      <div class="budget-line">
        <span class={`spent${isEmpty(spentLabel) ? " empty" : ""}`}>{spentLabel}</span>
        <span class="of">
          of {portfolioCapLabel} project ceilings · {period}
        </span>
        <span class="pct">{pct}</span>
      </div>
      <div class="cap-bar" aria-hidden="true">
        {bar === null ? null : <div class="fill" style={{ width: `${bar}%` }} />}
      </div>
      <div class="budget-subs">
        <div class="sub-card">
          <div class="l">real spend</div>
          <div class={`v${isEmpty(spentLabel) ? " empty" : ""}`}>{spentLabel}</div>
          <div class="k">
            {mtd.spentUsd === undefined
              ? "no computable project spend"
              : `${mtd.spendSample} project${mtd.spendSample === 1 ? "" : "s"} summed`}
          </div>
        </div>
        <div class="sub-card">
          <div class="l">project ceilings</div>
          <div class={`v${isEmpty(portfolioCapLabel) ? " empty" : ""}`}>{portfolioCapLabel}</div>
          <div class="k">sum of gated project ceilings</div>
        </div>
        <div class="sub-card">
          <div class="l">org default</div>
          <div class={`v${isEmpty(orgDefaultLabel) ? " empty" : ""}`}>{orgDefaultLabel}</div>
          <div class="k">
            {orgBudgetUnavailable
              ? "org default unavailable"
              : `${mtd.orgDefaultPeriodLabel === "—" ? "default" : mtd.orgDefaultPeriodLabel} · inheritance only`}
          </div>
        </div>
      </div>
      {mtd.spendPeriodLabel === "mixed" ? (
        <div class="empty" data-period-mixed>
          Contributing projects use mixed budget periods — spend is summed across each project's own period, not one
          shared calendar window.
        </div>
      ) : null}
      {mtd.anyPaused ? <div class="pause-note">at least one project is halted on budget</div> : null}
      {mtd.failedReads > 0 ? (
        <div class="empty">
          {mtd.failedReads} project budget read{mtd.failedReads === 1 ? "" : "s"} failed — omitted from the sum.
        </div>
      ) : null}
      {orgBudgetUnavailable ? (
        <div class="empty">Org default budget read failed — inheritance default unavailable.</div>
      ) : null}
      <a class="link-out" href="/budget">
        budget panel ↗
      </a>
      <a class="link-out" href="/costs">
        history &amp; costs ↗
      </a>
    </div>
  );
}

function ForgeOrgCard() {
  // No org-wide forge conversation API is ready — keep the card honest rather
  // than stubbing prompts that do nothing. Operators still have the palette.
  return (
    <div class="forge-card" data-forge-org>
      <div class="head">
        <span class="stamp">鍛</span>
        <span class="title">
          forge · <em>org-wide</em>
        </span>
        <span class="meta">unavailable</span>
      </div>
      <div class="prompt" data-forge-unavailable>
        <span class="cue">▸</span>
        Org-wide forge questions are not wired yet. Use the command palette (⌘K) for project-scoped forge tools — no
        fabricated org answers here.
      </div>
    </div>
  );
}

function ActivityCard(props: {
  activity: OverviewActivityItem[];
  activityUnavailable: boolean;
  activityFailedReads: number;
  now: Date;
}) {
  const { activity, activityUnavailable, activityFailedReads, now } = props;

  return (
    <div class="col-card" data-activity>
      <div class="h">
        <span>
          activity · <em>recent</em>
        </span>
        <span class="meta">cross-project</span>
      </div>
      {activityUnavailable ? (
        <div class="empty" data-activity-unavailable>
          Activity unavailable — every project feed read failed. No events are fabricated.
        </div>
      ) : activity.length === 0 ? (
        <div class="empty" data-activity-empty>
          No recent activity across projects.
        </div>
      ) : (
        <div class="activity-rows">
          {activity.map((row) => {
            const kind = activityKind(row.eventType);
            // Run detail is mounted at /runs/:runId (not under /projects/...).
            const href = `/runs/${encodeURIComponent(row.runId)}`;
            return (
              <a class="activity-row" href={href} data-activity-ts={row.ts}>
                <span class="ts">{relativeCompact(row.ts, now)}</span>
                <span class="proj" title={row.projectName}>
                  {row.projectName}
                </span>
                <span class={`ev ${kind}`} title={row.eventType}>
                  {humanizeEvent(row.eventType)}
                  {row.specId === null || row.specId === "" ? "" : ` · ${row.specId}`}
                </span>
              </a>
            );
          })}
        </div>
      )}
      {!activityUnavailable && activityFailedReads > 0 ? (
        <div class="empty" data-activity-partial>
          {activityFailedReads} project feed{activityFailedReads === 1 ? "" : "s"} failed — those projects are omitted
          from this feed.
        </div>
      ) : null}
    </div>
  );
}

export function OverviewBody(props: OverviewBodyProps) {
  const {
    orgLogin,
    projects,
    projectsUnavailable,
    mtd,
    orgBudgetUnavailable,
    activity,
    activityUnavailable,
    activityFailedReads,
    now = new Date(),
  } = props;

  const projectCount = projects.length;
  const spentKpi = mtd?.spentUsd === undefined ? "—" : budgetUsd(mtd.spentUsd);
  const portfolioCapKpi = mtd?.projectCeilingsSumUsd === undefined ? "—" : budgetUsd(mtd.projectCeilingsSumUsd);
  const activityKpi = activityUnavailable ? "—" : String(activity.length);
  const projectsKpi = projectsUnavailable ? "—" : String(projectCount);

  const subParts: string[] = [
    projectsUnavailable ? "projects unavailable" : `${projectCount} project${projectCount === 1 ? "" : "s"}`,
    ...(mtd?.anyPaused ? (["budget halt open"] as const) : []),
  ];

  return (
    <>
      <style data-screen="overview" dangerouslySetInnerHTML={{ __html: OVERVIEW_SCREEN_CSS }} />
      <div class="page-head">
        <div>
          <div class="eyebrow">▮ org · {orgLogin || "—"}</div>
          <div class="page-title">
            the <em>command deck</em>
          </div>
          <div class="sub">{subParts.join(" · ")}</div>
        </div>
        <div class="head-actions">
          <a class="btn-ghost" href="/onboarding/new">
            + new project
          </a>
          <a class="btn-ghost" href="/onboarding/existing">
            + link existing
          </a>
        </div>
      </div>
      <div class="page-body">
        <div class="overview-screen">
          <div class="kpi-strip" data-kpi-strip>
            <div class="kpi">
              <span class="k">projects</span>
              <span class={`v${isEmpty(projectsKpi) ? " empty" : ""}`}>{projectsKpi}</span>
            </div>
            <div class="kpi">
              <span class="k">gated spend</span>
              <span class={`v${isEmpty(spentKpi) ? " empty" : ""}`}>{spentKpi}</span>
            </div>
            <div class="kpi">
              <span class="k">project ceilings</span>
              <span class={`v${isEmpty(portfolioCapKpi) ? " empty" : ""}`}>{portfolioCapKpi}</span>
            </div>
            <div class={`kpi${mtd?.anyPaused || activityFailedReads > 0 ? " warn" : ""}`}>
              <span class="k">recent events</span>
              <span class={`v${isEmpty(activityKpi) ? " empty" : ""}`}>{activityKpi}</span>
            </div>
          </div>

          <div class="split-row">
            <div class="panel" data-projects-panel>
              <div class="panel-head">
                <h3>
                  projects · <em>the portfolio</em>
                </h3>
                <span class="meta">click any tile to jump in</span>
              </div>
              <div class="panel-pad">
                {projectsUnavailable ? (
                  <div class="empty" data-projects-unavailable>
                    Projects unavailable — the org projects list read failed. No empty portfolio is fabricated.
                  </div>
                ) : projectCount === 0 ? (
                  <div class="empty" data-projects-empty>
                    No projects yet.{" "}
                    <a class="link-out" href="/onboarding/existing">
                      link an existing repo ↗
                    </a>{" "}
                    or{" "}
                    <a class="link-out" href="/onboarding/new">
                      start a new project +
                    </a>
                  </div>
                ) : (
                  <div class="proj-grid">
                    {projects.map((p) => (
                      <ProjectTile project={p} />
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div class="side-col">
              <BudgetCard mtd={mtd} orgBudgetUnavailable={orgBudgetUnavailable} />
              <ForgeOrgCard />
              <ActivityCard
                activity={activity}
                activityUnavailable={activityUnavailable}
                activityFailedReads={activityFailedReads}
                now={now}
              />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
