/**
 * in-2: typed integration-requirement contract panel (overview mount).
 * Displays live catalog + validate outcomes. Loud unavailable/malformed —
 * never decorative success. Does NOT edit IntegrationsBody (IN-1/#856 lease).
 */

import type {
  FetchCatalogResult,
  FetchValidateResult,
  IntegrationContractCatalog,
  IntegrationValidateFail,
  IntegrationValidateOk,
} from "../../api/integrationContracts.js";

export interface IntegrationContractPanelProps {
  catalog: FetchCatalogResult;
  productSample: FetchValidateResult;
  controlSample: FetchValidateResult;
  crossPlaneSample: FetchValidateResult;
}

function CatalogBlock(props: { catalog: IntegrationContractCatalog }) {
  const { catalog } = props;
  return (
    <div data-in2="catalog-ok">
      <div data-in2="domain-tag">
        domain · <code>{catalog.domainTag}</code>
      </div>
      <div data-in2="planes">
        planes · <code>{catalog.planes.join(", ")}</code>
      </div>
      <div data-in2="product-caps">
        product capabilities · <code>{catalog.productCapabilities.join(", ")}</code>
      </div>
      <div data-in2="control-caps">
        control capabilities · <code>{catalog.controlCapabilities.join(", ")}</code>
      </div>
      <div data-in2="binding-kinds">
        binding kinds · product <code>{catalog.productBindingKinds.length}</code> · control{" "}
        <code>{catalog.controlBindingKinds.length}</code>
      </div>
    </div>
  );
}

function ValidateOkBlock(props: { label: string; marker: string; body: IntegrationValidateOk }) {
  return (
    <div data-in2={props.marker} data-in2-state="ok">
      <div class="in2-label">{props.label}</div>
      <div>
        plane · <code data-in2="plane">{props.body.plane}</code> · capability ·{" "}
        <code data-in2="capability">{props.body.capability}</code>
      </div>
      <div>
        requirementDigest · <code data-in2="requirement-digest">{props.body.requirementDigest}</code>
      </div>
      <div>
        artifact · <code data-in2="artifact-digest">{props.body.artifact.digest}</code> ·{" "}
        <span data-in2="artifact-bytes">{props.body.artifact.byteSize}</span> bytes
      </div>
      {/* R3: honest checked-vs-persisted state, never a false "stored" claim. */}
      <div data-in2="persistence">
        {props.body.persisted ? "persisted · durable CAS artifact" : "checked · not persisted (no CAS write)"}
      </div>
    </div>
  );
}

function ValidateFailBlock(props: { label: string; marker: string; body: IntegrationValidateFail }) {
  return (
    <div data-in2={props.marker} data-in2-state="invalid">
      <div class="in2-label">{props.label}</div>
      <div data-in2="reject">rejected ({props.body.errors.length} issue(s))</div>
      <ul data-in2="errors">
        {props.body.errors.map((e) => (
          <li key={`${e.path}:${e.code}`}>
            <code data-in2-code={e.code}>{e.code}</code> · {e.path}: {e.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ValidateResultBlock(props: { label: string; marker: string; result: FetchValidateResult }) {
  const { label, marker, result } = props;
  if (result.kind === "auth") {
    return (
      <div data-in2={marker} data-in2-state="auth">
        <div class="in2-label">{label}</div>
        <div data-in2="auth">access denied ({result.status}) — validation hidden</div>
      </div>
    );
  }
  if (result.kind === "unavailable") {
    return (
      <div data-in2={marker} data-in2-state="unavailable">
        <div class="in2-label">{label}</div>
        <div data-in2="unavailable">validate unavailable ({result.reason})</div>
      </div>
    );
  }
  if (result.kind === "invalid") {
    return <ValidateFailBlock label={label} marker={marker} body={result.body} />;
  }
  return <ValidateOkBlock label={label} marker={marker} body={result.body} />;
}

export function IntegrationContractPanel(props: IntegrationContractPanelProps) {
  const { catalog, productSample, controlSample, crossPlaneSample } = props;

  return (
    <section class="in2-contracts" data-in2="panel">
      <style
        data-screen="in2-contracts"
        dangerouslySetInnerHTML={{
          __html: `
.in2-contracts { margin-top: 16px; border: 1px solid var(--border, #333); border-radius: 8px; padding: 12px 14px; }
.in2-contracts h3 { margin: 0 0 8px; font-size: 14px; font-weight: 600; }
.in2-contracts .in2-label { font-weight: 600; margin-bottom: 4px; }
.in2-contracts [data-in2-state] { margin-top: 10px; padding-top: 8px; border-top: 1px dashed var(--border, #333); font-size: 12px; line-height: 1.45; }
.in2-contracts code { font-size: 11px; word-break: break-all; }
.in2-contracts ul { margin: 4px 0 0 16px; padding: 0; }
`,
        }}
      />
      <h3>integration contracts (in-2)</h3>
      <div data-in2="subtitle">typed requirement documents · control plane ≠ product plane · CAS-backed digest</div>

      {catalog.kind === "auth" ? (
        <div data-in2="catalog" data-in2-state="auth">
          catalog access denied ({catalog.status})
        </div>
      ) : null}
      {catalog.kind === "unavailable" ? (
        <div data-in2="catalog" data-in2-state="unavailable">
          catalog unavailable ({catalog.reason})
        </div>
      ) : null}
      {catalog.kind === "ok" ? (
        <div data-in2="catalog" data-in2-state="ok">
          <CatalogBlock catalog={catalog.catalog} />
        </div>
      ) : null}

      <ValidateResultBlock label="sample · product messaging.send" marker="sample-product" result={productSample} />
      <ValidateResultBlock label="sample · control control.notify" marker="sample-control" result={controlSample} />
      <ValidateResultBlock
        label="negative · control credential as product messaging"
        marker="sample-cross-plane"
        result={crossPlaneSample}
      />
    </section>
  );
}
