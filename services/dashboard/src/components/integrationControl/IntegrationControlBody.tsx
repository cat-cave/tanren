/**
 * in-21 — Integration Control Center visible body. Renders REAL data from
 * in-20's GET-only HTTP read surface (the orchestrator's `/v1/orgs/...` routes).
 * Every panel resolves to an in-20 endpoint; a failed read is honestly
 * surfaced as unavailable, never as a fabricated empty panel.
 *
 * Panels and the in-20 endpoint backing each:
 *   - lifecycle inventory      → GET .../integrations/lifecycle
 *   - integration requirements → GET .../integration-requirements
 *   - capability nodes         → GET .../capability-nodes
 *   - integration bindings     → GET .../integration-bindings (carries the in-15
 *                                appEnvHash PROOF, never a resolved env value)
 *   - delivery DAG             → GET .../delivery
 *
 * Downloadable schema catalog → /projects/:projectId/integration-control/schemas.json
 * (served by the BFF route; sources the bundled JSON-Schema files in
 * contracts/json/integrations/** via the generated TS module).
 */

import type {
  CapabilityNodeView,
  CapabilityNodesResponse,
  DeliveryDagStatusResponse,
  IntegrationBindingListItem,
  IntegrationBindingsResponse,
  IntegrationLifecycleInventoryResponse,
  IntegrationReadResult,
  IntegrationRequirementView,
  IntegrationRequirementsResponse,
} from "../../api/integrationReads.js";
import {
  INTEGRATION_READ_SCHEMA_CATALOG_VERSION,
  integrationReadSchemaCatalog,
} from "../../api/integrationReadSchemaCatalog.gen.js";
import { BindingCard, DeliveryRunCard } from "./IntegrationControlCards.js";
import { INTEGRATION_CONTROL_CSS } from "./styles.js";

export interface IntegrationControlData {
  /** Lifecycle inventory rollup (in-3, first-class in in-20). */
  readonly lifecycle: IntegrationReadResult<IntegrationLifecycleInventoryResponse> | undefined;
  /** Integration requirements (the project's typed lifecycle rows). */
  readonly requirements: IntegrationReadResult<IntegrationRequirementsResponse> | undefined;
  /** Capability nodes (in-9 / in-10 / in-17). */
  readonly capabilityNodes: IntegrationReadResult<CapabilityNodesResponse> | undefined;
  /** Integration bindings + the in-15 appEnvHash proof (in-14 / in-15). */
  readonly bindings: IntegrationReadResult<IntegrationBindingsResponse> | undefined;
  /** Delivery-DAG status (in-17 / in-19). */
  readonly delivery: IntegrationReadResult<DeliveryDagStatusResponse> | undefined;
}

export interface IntegrationControlBodyProps {
  readonly projectName: string;
  readonly projectId: string;
  /** True only when the path project is visible in the operator's org. */
  readonly scopeVisible: boolean;
  readonly data: IntegrationControlData;
}

type PanelState<T> =
  | { readonly kind: "ready"; readonly data: T }
  | { readonly kind: "empty" }
  | { readonly kind: "unavailable" };

function panelState<T>(result: IntegrationReadResult<T> | undefined, isEmpty: (data: T) => boolean): PanelState<T> {
  if (result === undefined) return { kind: "unavailable" };
  if (!result.ok) return { kind: "unavailable" };
  return isEmpty(result.data) ? { kind: "empty" } : { kind: "ready", data: result.data };
}

function unavailablePanel(message: string, marker: string) {
  return (
    <div class="state unavailable" data-integration-control-unavailable={marker}>
      {message}
    </div>
  );
}

function emptyPanel(message: string, marker: string) {
  return (
    <div class="state empty" data-integration-control-empty={marker}>
      {message}
    </div>
  );
}

function LifecyclePanel(props: { readonly result: IntegrationControlData["lifecycle"] }) {
  const state = panelState(
    props.result,
    (data) =>
      data.requirements.total === 0 &&
      data.capabilityNodes.total === 0 &&
      data.bindings.total === 0 &&
      data.deliveries.total === 0,
  );
  return (
    <section class="panel" data-integration-control-lifecycle>
      <div class="panel-head">
        <h2>lifecycle inventory</h2>
        <span class="meta">GET …/integrations/lifecycle</span>
      </div>
      <div class="panel-body">
        {state.kind === "unavailable" ? (
          unavailablePanel(
            "Lifecycle inventory unavailable — the orchestrator read failed. No counts are fabricated.",
            "lifecycle",
          )
        ) : state.kind === "empty" ? (
          emptyPanel(
            "No integration lifecycle rows yet. This is an empty project, not a zero-count over existing data.",
            "lifecycle",
          )
        ) : (
          <div class="lifecycle-grid">
            <Bucket
              label="requirements"
              total={state.data.requirements.total}
              detail={`${state.data.requirements.needsAttention} need attention`}
            />
            <Bucket
              label="capability nodes"
              total={state.data.capabilityNodes.total}
              detail={`${state.data.capabilityNodes.ready} ready · ${state.data.capabilityNodes.awaitingGrant} awaiting grant`}
            />
            <Bucket
              label="bindings"
              total={state.data.bindings.total}
              detail={`${state.data.bindings.ready} ready · ${state.data.bindings.drifted} drifted`}
            />
            <Bucket
              label="deliveries"
              total={state.data.deliveries.total}
              detail={`${state.data.deliveries.completed} complete · ${state.data.deliveries.degraded} degraded`}
            />
          </div>
        )}
      </div>
    </section>
  );
}

function Bucket(props: { label: string; total: number; detail: string }) {
  return (
    <div class="bucket">
      <span class="bucket-label">{props.label}</span>
      <span class="bucket-total">{props.total}</span>
      <span class="bucket-detail">{props.detail}</span>
    </div>
  );
}

function RequirementsPanel(props: { readonly result: IntegrationControlData["requirements"] }) {
  const state = panelState(props.result, (data) => data.requirements.length === 0);
  return (
    <section class="panel" data-integration-control-requirements>
      <div class="panel-head">
        <h2>integration requirements</h2>
        <span class="meta">GET …/integration-requirements</span>
      </div>
      <div class="panel-body">
        {state.kind === "unavailable" ? (
          unavailablePanel(
            "Integration requirements unavailable — the orchestrator read failed. No requirement list is fabricated.",
            "requirements",
          )
        ) : state.kind === "empty" ? (
          emptyPanel("No integration requirements have been derived for this project yet.", "requirements")
        ) : (
          <table class="table">
            <thead>
              <tr>
                <th>capability</th>
                <th>plane</th>
                <th>direction</th>
                <th>criticality</th>
                <th>status</th>
                <th>source digest</th>
              </tr>
            </thead>
            <tbody>
              {state.data.requirements.map((row: IntegrationRequirementView) => (
                <tr
                  data-integration-control-requirement={row.requirementId}
                  data-integration-control-requirement-status={row.status}
                >
                  <td>{row.capability}</td>
                  <td>{row.plane}</td>
                  <td>{row.direction}</td>
                  <td>{row.criticality}</td>
                  <td>
                    <span class="state-pill" data-integration-control-requirement-state={row.status}>
                      {row.status}
                    </span>
                  </td>
                  <td>
                    <code class="hash">{row.sourceDigest}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function CapabilityNodesPanel(props: { readonly result: IntegrationControlData["capabilityNodes"] }) {
  const state = panelState(props.result, (data) => data.capabilityNodes.length === 0);
  return (
    <section class="panel" data-integration-control-capability-nodes>
      <div class="panel-head">
        <h2>capability nodes</h2>
        <span class="meta">GET …/capability-nodes</span>
      </div>
      <div class="panel-body">
        {state.kind === "unavailable" ? (
          unavailablePanel(
            "Capability nodes unavailable — the orchestrator read failed. No node list is fabricated.",
            "capabilityNodes",
          )
        ) : state.kind === "empty" ? (
          emptyPanel("No capability nodes have been prepared for this project yet.", "capabilityNodes")
        ) : (
          <table class="table">
            <thead>
              <tr>
                <th>node</th>
                <th>environment</th>
                <th>executor</th>
                <th>status</th>
                <th>wait reason</th>
                <th>desired state hash</th>
              </tr>
            </thead>
            <tbody>
              {state.data.capabilityNodes.map((row: CapabilityNodeView) => (
                <tr
                  data-integration-control-capability-node={row.nodeId}
                  data-integration-control-capability-node-status={row.status}
                >
                  <td>
                    <code class="id">{row.nodeId}</code>
                    <br />
                    <span class="muted">req {row.requirementId}</span>
                  </td>
                  <td>{row.environment}</td>
                  <td>{row.executorKind}</td>
                  <td>
                    <span class="state-pill" data-integration-control-capability-node-state={row.status}>
                      {row.status}
                    </span>
                  </td>
                  <td>{row.waitReason ?? "—"}</td>
                  <td>
                    <code class="hash">{row.desiredStateHash}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function BindingsPanel(props: { readonly result: IntegrationControlData["bindings"] }) {
  const state = panelState(props.result, (data) => data.bindings.length === 0);
  return (
    <section class="panel" data-integration-control-bindings>
      <div class="panel-head">
        <h2>integration bindings · appEnvHash proof</h2>
        <span class="meta">GET …/integration-bindings</span>
      </div>
      <div class="panel-body">
        {state.kind === "unavailable" ? (
          unavailablePanel(
            "Integration bindings unavailable — the orchestrator read failed. No binding list is fabricated.",
            "bindings",
          )
        ) : state.kind === "empty" ? (
          emptyPanel("No integration bindings exist for this project yet.", "bindings")
        ) : (
          <div class="bindings-list">
            {state.data.bindings.map((row: IntegrationBindingListItem) => (
              <BindingCard row={row} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function DeliveryPanel(props: { readonly result: IntegrationControlData["delivery"] }) {
  const state = panelState(props.result, (data) => data.deliveryRuns.length === 0);
  return (
    <section class="panel" data-integration-control-delivery>
      <div class="panel-head">
        <h2>delivery DAG</h2>
        <span class="meta">GET …/delivery</span>
      </div>
      <div class="panel-body">
        {state.kind === "unavailable" ? (
          unavailablePanel(
            "Delivery DAG unavailable — the orchestrator read failed. No run list is fabricated.",
            "delivery",
          )
        ) : state.kind === "empty" ? (
          emptyPanel("No delivery runs have been recorded for this project yet.", "delivery")
        ) : (
          <div class="delivery-list">
            {state.data.deliveryRuns.map((run) => (
              <DeliveryRunCard run={run} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function SchemaCatalogPanel(props: { readonly projectId: string }) {
  return (
    <section class="panel" data-integration-control-schemas>
      <div class="panel-head">
        <h2>read-surface schema catalog</h2>
        <span class="meta">
          {integrationReadSchemaCatalog.length} schemas · version {INTEGRATION_READ_SCHEMA_CATALOG_VERSION}
        </span>
      </div>
      <div class="panel-body">
        <p class="hint">
          The frozen JSON-Schema set for the in-20 read HTTP surface, drift-gated against{" "}
          <code>contracts/json/integrations/**</code>. Download mirrors exactly what an external reader consumes.
        </p>
        <ul class="schema-list">
          {integrationReadSchemaCatalog.map((entry) => (
            <li data-integration-control-schema={entry.name}>
              <a
                class="schema-link"
                href={`/projects/${encodeURIComponent(props.projectId)}/integration-control/schemas.json?name=${encodeURIComponent(entry.name)}`}
                data-integration-control-schema-download={entry.name}
              >
                {entry.name}.json
              </a>
              <span class="muted">{entry.schemaId}</span>
            </li>
          ))}
        </ul>
        <a
          class="btn primary"
          href={`/projects/${encodeURIComponent(props.projectId)}/integration-control/schemas.json`}
          data-integration-control-schema-download="bundle"
        >
          download bundled catalog
        </a>
      </div>
    </section>
  );
}

export function IntegrationControlBody(props: IntegrationControlBodyProps) {
  return (
    <>
      <style data-screen="integration-control" dangerouslySetInnerHTML={{ __html: INTEGRATION_CONTROL_CSS }} />
      <div class="page-head">
        <div>
          <div class="eyebrow">▮ project · {props.projectName || props.projectId} · integration lifecycle</div>
          <div class="page-title">Integration Control Center</div>
          <div class="sub">
            capability nodes, bindings + the in-15 appEnvHash proof, and delivery-DAG status — backed by the in-20 read
            surface
          </div>
        </div>
      </div>
      <div class="page-body">
        <div class="integration-control-screen">
          {props.scopeVisible ? (
            <>
              <LifecyclePanel result={props.data.lifecycle} />
              <RequirementsPanel result={props.data.requirements} />
              <CapabilityNodesPanel result={props.data.capabilityNodes} />
              <BindingsPanel result={props.data.bindings} />
              <DeliveryPanel result={props.data.delivery} />
              <SchemaCatalogPanel projectId={props.projectId} />
            </>
          ) : (
            <section class="panel">
              <div class="panel-body state unavailable" data-integration-control-no-project>
                The requested project is not visible in this organization; no integration read was attempted.
              </div>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
