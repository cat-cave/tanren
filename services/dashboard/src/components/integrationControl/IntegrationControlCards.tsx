/**
 * in-21 — Integration Control Center detail cards (binding + delivery). Split
 * out of `IntegrationControlBody.tsx` so each source file stays under the
 * 500-line architecture cap. Each card renders REAL data from a REAL in-20
 * endpoint, with the in-15 appEnvHash PROOF surfaced (never a resolved env
 * value / token / principal secret).
 */

import type { DeliveryRunView, IntegrationBindingListItem } from "../../api/integrationReads.js";

function Fact(props: { label: string; value: string }) {
  return (
    <div class="kv">
      <span class="kv-label">{props.label}</span>
      <span class="kv-value">{props.value}</span>
    </div>
  );
}

export function BindingCard(props: { row: IntegrationBindingListItem }) {
  const row = props.row;
  const gen = row.currentGeneration;
  return (
    <article
      class="binding-card"
      data-integration-control-binding={row.bindingId}
      data-integration-control-binding-status={row.status}
    >
      <header>
        <div>
          <span class="binding-id">
            <code class="id">{row.bindingId}</code>
          </span>
          <span class="binding-meta">
            {row.providerKind} · {row.environment} · conn <code class="id">{row.connectionId}</code>
          </span>
        </div>
        <span class="state-pill" data-integration-control-binding-state={row.status}>
          {row.status}
        </span>
      </header>
      <div class="binding-grid">
        <Fact label="requirement" value={row.requirementId} />
        <Fact label="drift state" value={row.driftState} />
        <Fact
          label="current generation"
          value={row.currentGenerationNumber === null ? "pending" : String(row.currentGenerationNumber)}
        />
      </div>
      {gen === null ? (
        <div class="state empty" data-integration-control-binding-pending={row.bindingId}>
          No sealed current generation yet (binding still pending).
        </div>
      ) : (
        <div class="binding-generation" data-integration-control-binding-generation={row.bindingId}>
          <div class="binding-grid">
            <Fact label="grant" value={`${gen.grantId} @ ${gen.grantGeneration}`} />
            <Fact label="auth generation" value={String(gen.authGeneration)} />
            <Fact label="adapter" value={gen.adapterVersion} />
            <Fact label="ownership" value={gen.ownership} />
            <Fact label="teardown" value={gen.teardownPolicy} />
            <Fact
              label="external resource"
              value={`${gen.resource.externalResourceId} · ${gen.resource.externalResourceName}`}
            />
          </div>
          <div class="env-proof" data-integration-control-app-env-hash={gen.appEnvHash}>
            <span class="proof-label">appEnvHash PROOF (in-15)</span>
            <code class="hash">{gen.appEnvHash}</code>
            <span class="proof-note">
              content digest of the canonical app-env the materializer sealed — never a resolved value
            </span>
          </div>
          <div class="env-shape">
            <span class="proof-label">output shape ({gen.outputs.length} keys)</span>
            <ul>
              {gen.outputs.map((output) => (
                <li data-integration-control-env-key={output.logicalKey}>
                  <code>{output.logicalKey}</code>
                  <span class="muted">
                    {" "}
                    · {output.classification}
                    {output.required ? " · required" : ""}
                  </span>
                  <span class="scopes">{output.scopes.join(" · ")}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </article>
  );
}

export function DeliveryRunCard(props: { run: DeliveryRunView }) {
  const run = props.run;
  return (
    <article
      class="delivery-card"
      data-integration-control-delivery-run={run.deliveryRunId}
      data-integration-control-delivery-run-status={run.status}
    >
      <header>
        <div>
          <span class="delivery-id">
            <code class="id">{run.deliveryRunId}</code>
          </span>
          <span class="delivery-meta">
            merge <code class="hash">{run.mergeSha}</code> · authority {run.authorityDecisionId}
          </span>
        </div>
        <span class="state-pill" data-integration-control-delivery-run-state={run.status}>
          {run.status}
        </span>
      </header>
      <div class="binding-grid">
        <Fact label="created" value={run.createdAt} />
        <Fact label="updated" value={run.updatedAt} />
        <Fact label="completed" value={run.completedAt ?? "—"} />
        {run.retryAfter === null ? null : <Fact label="retry after" value={run.retryAfter} />}
        {run.failureClassification === null ? null : <Fact label="failure" value={run.failureClassification} />}
      </div>
      <div class="stage-list">
        {run.stages.map((stage) => (
          <div
            class="stage-row"
            data-integration-control-delivery-stage={stage.stage}
            data-integration-control-delivery-stage-status={stage.latestStatus}
          >
            <span class="stage-name">{stage.stage}</span>
            <span class="state-pill" data-integration-control-delivery-stage-state={stage.latestStatus}>
              {stage.latestStatus}
            </span>
            <span class="muted">
              {" "}
              · attempt {stage.latestAttempt} · ord {stage.ordinal}
            </span>
            {stage.failureClassification === null ? null : <span class="muted"> · {stage.failureClassification}</span>}
          </div>
        ))}
      </div>
      <div class="binding-refs">
        <span class="proof-label">binding refs ({run.bindings.length})</span>
        <ul>
          {run.bindings.map((ref) => (
            <li data-integration-control-delivery-binding-ref={ref.bindingId}>
              <code>{ref.bindingId}</code>
              <span class="muted"> @ gen {ref.bindingGeneration}</span>
            </li>
          ))}
        </ul>
      </div>
    </article>
  );
}
