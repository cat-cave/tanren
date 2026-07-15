import { migrateProjectConfig, type ProjectConfigV1 } from "../config/index.js";

const projectConfigWriteProofBrand = Symbol("projectConfigWriteProof");

export interface ProjectConfigWriteProof {
  readonly [projectConfigWriteProofBrand]: true;
  readonly kind: "provisioned_greenfield";
}

export const provisionedGreenfieldProjectConfigProof: ProjectConfigWriteProof = Object.freeze({
  [projectConfigWriteProofBrand]: true as const,
  kind: "provisioned_greenfield",
});

const PROVISIONED_DEPLOY_CONFIG_FIELDS = [
  "deployProvider",
  "deployAppId",
  "deployAppName",
  "previewUrlPattern",
  "envAttachmentRef",
] as const satisfies ReadonlyArray<keyof ProjectConfigV1>;

const BROWNFIELD_SAFE_GOVERNANCE_POSTURE = "strict";
const BROWNFIELD_SAFE_MERGE_INTEGRATION = "not_configured";

const FULL_CONFIG_PATCH_RESERVED_FIELDS = [
  "greenfield",
  "reviewPolicy",
  "mergeIntegration",
  "governancePosture",
  // gv-1: `auditPosture` is a governance-owned DORA knob (a governed SETTING like
  // `governancePosture`/`reviewPolicy`, see auditPostureConfig.ts). It must NOT be
  // mutable through the generic member PATCH — only through the org-admin governance
  // PUT. Compared structurally (it is a nested object), so an unchanged value
  // round-trips while a genuine change is reserved out.
  "auditPosture",
  ...PROVISIONED_DEPLOY_CONFIG_FIELDS,
] as const;

export interface ProjectConfigWriteRejectionResponse {
  error:
    | "invalid_project_config"
    | "manual_autonomous_project_config"
    | "manual_deploy_project_config"
    | "manual_greenfield_project_config"
    | "reserved_project_config_patch";
  message: string;
  fields?: string[];
}

export class ProjectConfigWriteRejectedError extends Error {
  constructor(readonly response: ProjectConfigWriteRejectionResponse) {
    super(response.message);
    this.name = "ProjectConfigWriteRejectedError";
  }
}

type ProjectConfigCheck = { ok: true } | { ok: false; response: ProjectConfigWriteRejectionResponse };

type ProjectConfigPatchCheck =
  | { ok: true; config: ProjectConfigV1 }
  | { ok: false; response: ProjectConfigWriteRejectionResponse };

export function checkGenericProjectCreateConfig(rawConfig: Record<string, unknown> | undefined): ProjectConfigCheck {
  if (rawConfig === undefined) {
    return { ok: true };
  }
  try {
    assertProjectCreateConfigAllowed(rawConfig);
    return { ok: true };
  } catch (error) {
    if (error instanceof ProjectConfigWriteRejectedError) {
      return { ok: false, response: error.response };
    }
    return { ok: false, response: { error: "invalid_project_config", message: messageOf(error) } };
  }
}

export function assertProjectCreateConfigAllowed(rawConfig: unknown, proof?: ProjectConfigWriteProof): ProjectConfigV1 {
  const config = migrateProjectConfig(rawConfig);
  if (proof === provisionedGreenfieldProjectConfigProof) {
    return config;
  }

  const raw = rawRecord(rawConfig);
  const deployFields = presentFields(raw, PROVISIONED_DEPLOY_CONFIG_FIELDS);
  if (deployFields.length > 0) {
    throw new ProjectConfigWriteRejectedError({
      error: "manual_deploy_project_config",
      message: "deploy target config must come from real deploy provisioning, not a generic project create body",
      fields: deployFields,
    });
  }

  if (raw["greenfield"] === true || config.greenfield) {
    throw new ProjectConfigWriteRejectedError({
      error: "manual_greenfield_project_config",
      message: "greenfield/apex project config must be created through the provisioned greenfield or onboarding flow",
      fields: ["greenfield"],
    });
  }

  const autonomyFields = reservedAutonomyCreateFields(config, raw);
  if (autonomyFields.length > 0) {
    throw new ProjectConfigWriteRejectedError({
      error: "manual_autonomous_project_config",
      message: "autonomous project config must be set through a supported provisioning or governance path",
      fields: autonomyFields,
    });
  }

  return config;
}

export function checkFullProjectConfigPatch(
  rawConfig: Record<string, unknown>,
  currentConfig: ProjectConfigV1,
): ProjectConfigPatchCheck {
  let config: ProjectConfigV1;
  try {
    config = migrateProjectConfig(rawConfig);
  } catch (error) {
    return { ok: false, response: { error: "invalid_project_config", message: messageOf(error) } };
  }

  const fields = changedFields(config, currentConfig, FULL_CONFIG_PATCH_RESERVED_FIELDS);
  if (fields.length > 0) {
    return {
      ok: false,
      response: {
        error: "reserved_project_config_patch",
        message: "reserved greenfield, deploy, and governance config must be changed through supported endpoints",
        fields,
      },
    };
  }

  return { ok: true, config };
}

function reservedAutonomyCreateFields(config: ProjectConfigV1, raw: Record<string, unknown>): string[] {
  const fields: string[] = [];
  if (config.reviewPolicy !== "human" && raw["reviewPolicy"] !== undefined) {
    fields.push("reviewPolicy");
  }
  if (config.mergeIntegration !== BROWNFIELD_SAFE_MERGE_INTEGRATION && raw["mergeIntegration"] !== undefined) {
    fields.push("mergeIntegration");
  }
  if (config.governancePosture !== BROWNFIELD_SAFE_GOVERNANCE_POSTURE && raw["governancePosture"] !== undefined) {
    fields.push("governancePosture");
  }
  // Unlike the legacy autonomy toggles above, audit posture has no caller-safe
  // value on generic creation: even its defaults are governance-owned. A trusted
  // provisioner bypasses this whole guard with the branded proof above.
  if (raw["auditPosture"] !== undefined) {
    fields.push("auditPosture");
  }
  return fields;
}

function presentFields(raw: Record<string, unknown>, fields: readonly string[]): string[] {
  return fields.filter((field) => raw[field] !== undefined);
}

function changedFields(
  nextConfig: ProjectConfigV1,
  currentConfig: ProjectConfigV1,
  fields: readonly (keyof ProjectConfigV1)[],
): string[] {
  // `auditPosture` is a nested object, so reference equality (`!==`) would always
  // report it changed after re-parsing even when the value is identical. Structural
  // JSON equality preserves the existing primitive-field behavior exactly (primitives
  // compare by value under ===) while correctly diffing the nested governed setting.
  return fields.filter((field) => !jsonEqual(nextConfig[field], currentConfig[field]));
}

function rawRecord(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Structural equality over the JSON value domain (the parsed config values are all
// JSON-serializable). For primitives this is identical to `===`/`!==`; for objects
// and arrays it compares recursively so a re-parsed nested governed setting (e.g.
// `auditPosture`) is only "changed" when its contents genuinely differ.
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => jsonEqual(value, b[index]))
    );
  }
  const ar = a as Record<string, unknown>;
  const br = b as Record<string, unknown>;
  const ak = Object.keys(ar);
  const bk = Object.keys(br);
  return ak.length === bk.length && ak.every((key) => jsonEqual(ar[key], br[key]));
}
