/**
 * spec-discovery surface (the hi-fi `view-discovery` flow). Composes:
 *   - an INSIGHT card with provenance (source / who / when / glyph) + an
 *     editable body the operator classifies;
 *   - the FORGE CLASSIFICATION thread (summary + read-hint) — the same Forge
 *     answerer seam as the conversation surface, here flavoured for discovery;
 *   - PROPOSED-SPEC cards;
 *   - the three DAG-PLACEMENT options (slot-after / jump-backlog / interrupt),
 *     one marked recommended, selectable via the discovery island (DAG);
 *   - the deltas + impact panel (personas / behaviors / specs).
 *
 * Classification is a server POST (`/projects/:projectId/discovery?classify`),
 * which re-renders this body with `result` populated. Accept is a form POST to
 * `/projects/:projectId/discovery/accept` that creates the specs with
 * provenance and places them per the chosen option. The island only manages
 * placement selection + the hidden payload wiring; the writes stay server-side.
 */

import type { ProjectSummary } from "../../api/types.js";
import type {
  DiscoveryInsight,
  DiscoveryResult,
  DiscoveryVariant,
  PlacementOption,
  ProposedSpec,
} from "../../api/discoveryTypes.js";
import { ScreenStyles } from "../project/screenStyles.js";
import { PageHead } from "../project/shared.js";
import { DiscoveryStyles } from "./discoveryStyles.js";
import { VARIANT_EYEBROW } from "./seeds.js";

export interface DiscoveryBodyProps {
  project: ProjectSummary;
  orgId: string;
  variant: DiscoveryVariant;
  insight: DiscoveryInsight;
  /** Present after a classify POST — drives the thread + proposal + placement UI. */
  result?: DiscoveryResult;
  /** Set when accept created specs — rendered as a success banner. */
  accepted?: { count: number; placementLabel: string };
  error?: string;
}

const VARIANTS: DiscoveryVariant[] = ["feature", "bug", "strategic"];

function VariantTabs(props: { project: ProjectSummary; active: DiscoveryVariant }) {
  return (
    <div class="variant-tabs" data-discovery="variant-tabs">
      {VARIANTS.map((v) => (
        <a
          class={v === props.active ? "active" : ""}
          href={`/projects/${props.project.projectId}/discovery?variant=${v}`}
        >
          {v}
        </a>
      ))}
    </div>
  );
}

function InsightBanner(props: { insight: DiscoveryInsight; variant: DiscoveryVariant }) {
  const i = props.insight;
  return (
    <div class={`insight-banner${props.variant === "bug" ? " fail" : ""}`} data-discovery="insight">
      <div class="glyph">{i.glyph}</div>
      <div style="flex:1; min-width:0;">
        <div class="meta">
          <span>{i.sourceLabel}</span>
          <span>·</span>
          <b>{i.source}</b>
          <span>·</span>
          <span>{i.who}</span>
          <span>·</span>
          <span>{i.when}</span>
        </div>
        <div class="body">{i.body}</div>
      </div>
    </div>
  );
}

function ProposalCard(props: { proposal: ProposedSpec }) {
  const p = props.proposal;
  return (
    <div class="col-card live" data-discovery="proposal" data-proposal-id={p.proposalId}>
      <div class="h">proposed spec</div>
      <div class="display-h">{p.title}</div>
      <div class="det">{p.description}</div>
      <div class="det">
        acceptance · {p.acceptanceCriteria.length} criteria
        {p.dependsOn.length > 0 ? <> · depends on {p.dependsOn.join(", ")}</> : null}
      </div>
      <div class="det">
        est · {p.estLabel || "—"} · priority <b>{p.priority}</b>
      </div>
    </div>
  );
}

function PlacementOptionCard(props: { option: PlacementOption; index: number }) {
  const o = props.option;
  const cls = ["place-opt", o.recommended ? "rec" : "", o.risk ? "risk" : "", o.recommended ? "sel" : ""]
    .filter((x) => x !== "")
    .join(" ");
  return (
    <button
      type="button"
      class={cls}
      data-discovery="placement"
      data-placement-kind={o.kind}
      data-placement-label={o.label}
      data-placement-index={String(props.index)}
    >
      <div class="pl-top">
        <span class="pl-label">{o.label}</span>
        <span class="pl-prio">
          {o.priority}
          {o.recommended ? " · recommended" : ""}
        </span>
      </div>
      <div class="pl-meta">
        <span class="eta">{o.eta}</span>
        <span>↑ {o.sideEffects}</span>
      </div>
    </button>
  );
}

function DeltaCard(props: { delta: DiscoveryResult["deltas"][number] }) {
  const d = props.delta;
  return (
    <div class={`delta-card ${d.kind}`}>
      <div class="dc-head">
        <span class="dc-title">{d.title}</span>
        <span class="dc-count">{d.count}</span>
      </div>
      {d.deltas.length > 0 ? (
        <ul>
          {d.deltas.map((line) => (
            <li>{line}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ClassificationPanel(props: DiscoveryBodyProps & { result: DiscoveryResult }) {
  const { result, project, orgId, insight, variant } = props;
  const recommended = result.placements.find((p) => p.recommended);
  return (
    <div
      class="disc-split"
      data-island="discovery"
      data-org-id={orgId}
      data-project-id={project.projectId}
      data-accept-url={`/projects/${project.projectId}/discovery/accept`}
    >
      <div>
        <div class="sect-label">▮ forge · classification</div>
        <div class="panel">
          <div class="panel-head">
            <h3>
              discovery · <em>{variant}</em>
            </h3>
            <span class="meta">{result.readSummary}</span>
          </div>
          <div class="panel-body">
            <p style="font-family:var(--font-ui); font-size:13px; color:var(--fg-1); line-height:1.5; margin:0 0 12px;">
              {result.summary}
            </p>
            <div class="sect-label">proposed · {result.proposals.length} spec(s)</div>
            {result.proposals.map((p) => (
              <ProposalCard proposal={p} />
            ))}
          </div>
        </div>
      </div>

      <div>
        <div class="sect-label">▮ where in the dag</div>
        {result.placements.map((o, i) => (
          <PlacementOptionCard option={o} index={i} />
        ))}

        <form method="post" action={`/projects/${project.projectId}/discovery/accept`} data-discovery="accept-form">
          <input type="hidden" name="orgId" value={orgId} />
          <input type="hidden" name="variant" value={variant} />
          <input type="hidden" name="insight" value={JSON.stringify(insight)} />
          <input type="hidden" name="proposals" value={JSON.stringify(result.proposals)} />
          <input
            type="hidden"
            name="placementKind"
            value={recommended?.kind ?? result.placements[0]?.kind ?? "slot_after"}
            data-discovery="placement-kind"
          />
          <input
            type="hidden"
            name="placementLabel"
            value={recommended?.label ?? result.placements[0]?.label ?? ""}
            data-discovery="placement-label"
          />
          <button type="submit" class="btn primary" style="margin-top:10px; width:100%; justify-content:center;">
            add to dag · {result.proposals.length} spec(s) ↗
          </button>
          <div
            data-discovery="placement-chosen"
            style="font-family:var(--font-mono); font-size:10px; color:var(--fg-3); margin-top:6px; text-align:center;"
          >
            placement · {recommended?.label ?? result.placements[0]?.label ?? "—"}
          </div>
        </form>

        <div class="sect-label" style="margin-top:14px;">
          ▮ what's changing
        </div>
        {result.deltas.map((d) => (
          <DeltaCard delta={d} />
        ))}
      </div>
    </div>
  );
}

export function DiscoveryBody(props: DiscoveryBodyProps) {
  const { project, variant, insight } = props;
  return (
    <div class="p2b">
      <ScreenStyles />
      <DiscoveryStyles />
      <PageHead
        eyebrow={VARIANT_EYEBROW[variant]}
        title={
          <>
            discover a <em>spec</em>
          </>
        }
        sub={<>insight → forge classification → proposed specs → dag placement · feature · bug · strategic</>}
        actions={
          <a class="btn ghost" href={`/projects/${project.projectId}`}>
            ← project
          </a>
        }
      />
      <div class="page-body">
        {props.error === undefined ? null : <div class="form-error">{props.error}</div>}
        {props.accepted === undefined ? null : (
          <div class="insight-banner" style="border-left-color:var(--status-ok,oklch(58% 0.18 155));">
            <div class="glyph" style="color:var(--status-ok,oklch(58% 0.18 155));">
              ✓
            </div>
            <div class="body" style="margin-top:0;">
              added <b>{props.accepted.count}</b> spec(s) to the dag · placement <b>{props.accepted.placementLabel}</b>{" "}
              · provenance stamped on each spec. <a href={`/projects/${project.projectId}?mode=dag`}>view the dag ↗</a>
            </div>
          </div>
        )}

        <VariantTabs project={project} active={variant} />
        <InsightBanner insight={insight} variant={variant} />

        <form
          method="post"
          action={`/projects/${project.projectId}/discovery`}
          class="disc-form"
          data-discovery="classify-form"
        >
          <input type="hidden" name="variant" value={variant} />
          <input type="hidden" name="source" value={insight.source} />
          <input type="hidden" name="sourceLabel" value={insight.sourceLabel} />
          <input type="hidden" name="who" value={insight.who} />
          <input type="hidden" name="when" value={insight.when} />
          <input type="hidden" name="glyph" value={insight.glyph} />
          <label class="sect-label" for="disc-body">
            insight body · edit before classifying
          </label>
          <textarea id="disc-body" name="body">
            {insight.body}
          </textarea>
          <div class="row">
            <button type="submit" class="btn primary">
              classify with forge ↗
            </button>
          </div>
        </form>

        {props.result === undefined ? null : <ClassificationPanel {...props} result={props.result} />}
      </div>
    </div>
  );
}
