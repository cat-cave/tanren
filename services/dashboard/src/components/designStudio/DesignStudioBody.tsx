// ds-5 — the design Studio screen body: the within-org REUSE catalog, the
// project's current reuse BINDING + a bind form, the render-verdict EVIDENCE LAB,
// and the artifact EXPORT download list. Every section renders an explicit
// BLOCKED state when its read model is `undefined` (the client could not verify a
// 200 response) — never a fabricated empty/green.

import type {
  DesignDeliveryProof,
  DesignEcosystemView,
  DesignEvidenceVerdict,
  DesignExportFile,
  DesignStudioView,
  DesignSystemCatalogEntry,
  ProjectDesignBinding,
} from "../../api/designStudio.js";
import { CsrfField } from "../shell/CsrfField.js";
import { DESIGN_STUDIO_SCREEN_CSS } from "./styles.js";

export interface DesignStudioBodyProps {
  readonly view: DesignStudioView;
  readonly projectId: string;
  readonly projectName: string;
  readonly csrfToken?: string;
  readonly missingProject: boolean;
  readonly notice?: string;
  readonly error?: string;
}

function Blocked(props: { readonly what: string }) {
  return (
    <div class="alert" role="alert">
      <b>{props.what} unavailable.</b> The orchestrator did not return a valid response — this section is BLOCKED, not
      empty.
    </div>
  );
}

function outcomeTag(outcome: DesignEvidenceVerdict["outcome"]): string {
  if (outcome === "passed") return "pass";
  if (outcome === "failed_visual") return "fail";
  return "warn";
}

function ReuseCatalog(props: {
  readonly systems: readonly DesignSystemCatalogEntry[] | undefined;
  readonly binding: ProjectDesignBinding | null | undefined;
}) {
  return (
    <section class="panel">
      <div class="panel-pad">
        <div class="mini-eyebrow">within-org reusable design systems</div>
        {props.systems === undefined ? (
          <Blocked what="Design-system catalog" />
        ) : props.systems.length === 0 ? (
          <div class="empty">No published design systems in this org yet — nothing to reuse.</div>
        ) : (
          props.systems.map((system) => {
            const bound = props.binding?.designSystemId === system.designSystemId;
            return (
              <div class="system-row">
                <div class="row-head">
                  <b>{system.name}</b>
                  <code>{system.slug}</code>
                  <span class="tag">{system.lifecycle}</span>
                  {system.reuseCount > 0 ? <span class="tag reuse">reused ×{system.reuseCount}</span> : null}
                  {bound ? <span class="tag pass">bound here</span> : null}
                </div>
                <div class="row-head">
                  <span>{system.publishedReleaseCount} published release(s)</span>
                  {system.latestPublishedRelease === null ? (
                    <span class="tag warn">no published release</span>
                  ) : (
                    <code>
                      latest v{system.latestPublishedRelease.version} · {system.latestPublishedRelease.releaseId}
                    </code>
                  )}
                  {system.channels.map((channel) => (
                    <code>
                      {channel.channel} → {channel.releaseId}
                    </code>
                  ))}
                </div>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

function BindingPanel(props: {
  readonly binding: ProjectDesignBinding | null | undefined;
  readonly systems: readonly DesignSystemCatalogEntry[] | undefined;
  readonly projectId: string;
  readonly csrfToken?: string;
}) {
  const reusable = (props.systems ?? []).filter((system) => system.latestPublishedRelease !== null);
  return (
    <section class="panel">
      <div class="panel-pad">
        <div class="mini-eyebrow">this project's reuse binding</div>
        {props.binding === undefined ? (
          <Blocked what="Reuse binding" />
        ) : props.binding === null ? (
          <div class="empty">This project is not reusing a shared design system.</div>
        ) : (
          <div class="row-head">
            <span class="tag pass">bound</span>
            <code>system · {props.binding.designSystemId}</code>
            {props.binding.pinMode === "release" ? (
              <code>release · {props.binding.pinnedReleaseId}</code>
            ) : (
              <code>channel · {props.binding.channel}</code>
            )}
            <span>by {props.binding.boundBy}</span>
          </div>
        )}
        {reusable.length === 0 ? (
          <div class="empty">No published design system is available to bind.</div>
        ) : (
          <form method="post" action={`/projects/${props.projectId}/design-studio/bind`}>
            <CsrfField token={props.csrfToken} />
            <label>
              design system
              <select name="designSystemId">
                {reusable.map((system) => (
                  <option value={system.designSystemId}>{system.name}</option>
                ))}
              </select>
            </label>
            <label>
              pin mode
              <select name="pinMode">
                <option value="release">release</option>
                <option value="channel">channel</option>
              </select>
            </label>
            <label>
              release id (release pin)
              <input type="text" name="pinnedReleaseId" placeholder="release_…" />
            </label>
            <label>
              channel (channel pin)
              <input type="text" name="channel" placeholder="stable" />
            </label>
            <button type="submit">bind / reuse</button>
          </form>
        )}
      </div>
    </section>
  );
}

function EvidenceLab(props: { readonly evidence: DesignEvidenceVerdict | null | undefined }) {
  return (
    <section class="panel">
      <div class="panel-pad">
        <div class="mini-eyebrow">visual evidence lab · latest render verdict</div>
        {props.evidence === undefined ? (
          <Blocked what="Render evidence" />
        ) : props.evidence === null ? (
          <div class="empty">No design-render verdict recorded for this project yet.</div>
        ) : (
          <>
            <div class="row-head">
              <span class={`tag ${outcomeTag(props.evidence.outcome)}`}>{props.evidence.outcome}</span>
              <span>release · {props.evidence.releaseId}</span>
              <code>a11y · {props.evidence.accessibilityStandard}</code>
              <code>contract · {props.evidence.contractDigest ?? "unknown"}</code>
              {props.evidence.failingScenarioKey === null ? null : (
                <span class="tag fail">fails · {props.evidence.failingScenarioKey}</span>
              )}
            </div>
            {props.evidence.checkpoints.length === 0 ? (
              <div class="empty">Verdict recorded {props.evidence.checkpointCount} checkpoint(s), none itemized.</div>
            ) : (
              props.evidence.checkpoints.map((checkpoint) => (
                <div class="checkpoint">
                  <span
                    class={`tag ${checkpoint.verdict === "passed" ? "pass" : checkpoint.verdict === "failed" ? "fail" : "warn"}`}
                  >
                    {checkpoint.verdict}
                  </span>
                  <code>{checkpoint.checkpointId}</code>
                  {checkpoint.diffRatio === undefined ? null : <span>diff {checkpoint.diffRatio.toFixed(4)}</span>}
                  {checkpoint.failingRuleIds.length === 0 ? null : (
                    <span class="tag fail">{checkpoint.failingRuleIds.join(", ")}</span>
                  )}
                </div>
              ))
            )}
          </>
        )}
      </div>
    </section>
  );
}

function ExportsPanel(props: { readonly exports: readonly DesignExportFile[] | undefined }) {
  return (
    <section class="panel">
      <div class="panel-pad">
        <div class="mini-eyebrow">design-system exports · downloadable projections</div>
        {props.exports === undefined ? (
          <Blocked what="Exports" />
        ) : props.exports.length === 0 ? (
          <div class="empty">No exported design-system artifact is bound to this project yet.</div>
        ) : (
          <div class="export-list">
            {props.exports.map((file) => (
              <div class="export-row">
                <a href={file.href}>{file.path}</a>
                <code>{file.mediaType}</code>
                <span>{file.byteSize} B</span>
                <code>{file.digest}</code>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/** ds-8 — only destination-owned grants/forks and sanitized external receipts are visible. */
function EcosystemPanel(props: { readonly ecosystem: DesignEcosystemView | undefined }) {
  const ecosystem = props.ecosystem;
  return (
    <section class="panel">
      <div class="panel-pad">
        <div class="mini-eyebrow">ecosystem · grants, forks, and external quarantine</div>
        {ecosystem === undefined ? (
          <Blocked what="Ecosystem lineage" />
        ) : ecosystem.grants.length === 0 &&
          ecosystem.imports.length === 0 &&
          ecosystem.externalImports.length === 0 ? (
          <div class="empty">No redeemed grants, destination forks, or external snapshots yet.</div>
        ) : (
          <>
            {ecosystem.grants.map((grant) => (
              <div class="row-head">
                <span class={`tag ${grant.availability === "available" ? "pass" : "warn"}`}>{grant.availability}</span>
                <code>grant · {grant.id}</code>
                <span>{grant.capability}</span>
                <span>expires {grant.expiresAt}</span>
                <span>{grant.publicSlug ?? "public projection unavailable"}</span>
              </div>
            ))}
            {ecosystem.imports.map((imported) => (
              <div class="row-head">
                <span class={`tag ${imported.availability === "available" ? "pass" : "warn"}`}>
                  {imported.availability}
                </span>
                <code>fork · {imported.releaseId}</code>
                <span>{imported.syncPolicy}</span>
                <span>{imported.publicSlug ?? "public projection unavailable"}</span>
                <code>upstream · {imported.lastSeenUpstream}</code>
              </div>
            ))}
            {ecosystem.externalImports.map((external) => (
              <div class="row-head">
                <span class={`tag ${external.receipt.disposition === "rejected" ? "fail" : "warn"}`}>
                  {external.receipt.disposition}
                </span>
                <code>
                  {external.receipt.source} · {external.id}
                </code>
                <span>{external.receipt.externalRevision}</span>
                <span>{external.receipt.lossinessReport.lossless ? "lossless" : "lossy"}</span>
                <span>{external.receipt.licenseVerdict}</span>
              </div>
            ))}
          </>
        )}
      </div>
    </section>
  );
}

/** ds-6 — the delivery trace: eager matrix → proof key/root → release/deploy → proof-backed
 * demo. A read-only PROJECTION (no run-command control). Any missing cell, failed assertion,
 * or unobservable behavior renders as blocked/unknown — NEVER a fabricated A4 ≡ demo. */
function DeliveryTrace(props: { readonly delivery: DesignDeliveryProof | undefined }) {
  const delivery = props.delivery;
  const equivalent = delivery?.equivalence === "equivalent";
  return (
    <section class="panel">
      <div class="panel-pad">
        <div class="mini-eyebrow">delivery trace · queue → deploy → demo (A4 ≡ demo)</div>
        {delivery === undefined ? (
          <Blocked what="Delivery proof" />
        ) : (
          <>
            <div class="row-head">
              <span class={`tag ${equivalent ? "pass" : "warn"}`}>
                {equivalent ? "A4 ≡ demo" : delivery.equivalence}
              </span>
              <code>node · {delivery.integrationNodeId || "unbound"}</code>
              {delivery.boundKey === null ? null : <code>key · {delivery.boundKey.scenarioKey}</code>}
            </div>
            {delivery.preMerge === null ? (
              <div class="empty">No pre-merge design matrix bound to this delivery — trace BLOCKED, not empty.</div>
            ) : (
              <div class="row-head">
                <span class={`tag ${delivery.preMerge.renderOutcome === "passed" ? "pass" : "warn"}`}>
                  pre-merge · {delivery.preMerge.renderOutcome}
                </span>
                <code>root · {delivery.preMerge.proofRoot}</code>
                <span>{delivery.preMerge.cells.length} eager cell(s)</span>
                <code>artifact · {delivery.preMerge.artifactDigest}</code>
              </div>
            )}
            {delivery.production === null ? (
              <div class="empty">No live production release/demo linked yet — trace BLOCKED, not empty.</div>
            ) : (
              <div class="row-head">
                <span class={`tag ${equivalent ? "pass" : "warn"}`}>
                  live · {delivery.production.provider}/{delivery.production.environment}
                </span>
                <code>artifact · {delivery.production.artifactDigest}</code>
                <span>
                  demo {delivery.production.behaviorsPassed}/{delivery.production.behaviorCount} behavior(s) passed
                </span>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

export function DesignStudioBody(props: DesignStudioBodyProps) {
  return (
    <>
      <style data-screen="design-studio" dangerouslySetInnerHTML={{ __html: DESIGN_STUDIO_SCREEN_CSS }} />
      <div class="page-head">
        <div>
          <div class="eyebrow">▮ project · design · {props.projectName || "not found"}</div>
          <div class="page-title">design studio</div>
          <div class="sub">reuse a shared design system, browse its render evidence, and export its real artifacts</div>
        </div>
      </div>
      <div class="page-body">
        <div class="design-studio-screen">
          {props.error === undefined ? null : (
            <div class="alert" role="alert">
              <b>Binding failed.</b> {props.error}
            </div>
          )}
          {props.notice === undefined ? null : (
            <div class="notice" role="status">
              {props.notice}
            </div>
          )}
          {props.missingProject ? (
            <section class="panel">
              <div class="panel-pad">
                <div class="empty">This project is not visible in the active organization — the studio is BLOCKED.</div>
              </div>
            </section>
          ) : (
            <>
              <ReuseCatalog systems={props.view.systems} binding={props.view.binding} />
              <BindingPanel
                binding={props.view.binding}
                systems={props.view.systems}
                projectId={props.projectId}
                csrfToken={props.csrfToken}
              />
              <EvidenceLab evidence={props.view.evidence} />
              <DeliveryTrace delivery={props.view.delivery} />
              <EcosystemPanel ecosystem={props.view.ecosystem} />
              <ExportsPanel exports={props.view.exports} />
            </>
          )}
        </div>
      </div>
    </>
  );
}
