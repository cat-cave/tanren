import type { z } from "zod";

import { CiYamlParseError, parseYaml } from "../../ci/yaml.js";
import { IntegrationFragmentConfigSchema, type IntegrationFragmentConfig } from "../fragments/model.js";
import { IntegrationsManifestV1Schema, type IntegrationsManifestV1 } from "./schema.js";

// in-8: loader + resolver for `.tanren/integrations.yml`. Turns raw YAML text into a
// validated, typed manifest — or, for an ABSENT file, `undefined` (a project that
// declares no integrations, the clean no-op skip). Invalid input ALWAYS throws
// (never silently degrades / partially applies / defaults) so a misconfigured repo
// fails LOUD. This module performs no persistence and no external calls.
//
// Mirrors the `.tanren/ci.yml` split (ci/{schema,resolve,yaml}): the shape lives in
// schema.ts, the constrained YAML parser is reused from ci/yaml.ts (the same
// dependency-free subset — nested mappings, sequences of mappings, scalar arrays —
// is exactly what this manifest needs), and this module joins them fail-closed.

// A single normalized manifest issue (YAML syntax OR schema violation), so a caller
// reports both classes uniformly. `path` is a dotted JSON path ("<root>" at the top).
export interface IntegrationsManifestIssue {
  readonly path: string;
  readonly message: string;
}

// Thrown when `.tanren/integrations.yml` is present but does not parse to a valid
// manifest — a YAML syntax error, an unknown / mistyped field, a missing required
// field, a duplicate name/identity, or a plane / provider-policy contradiction. The
// SINGLE fail-closed error the manifest surface raises; callers map it to a 4xx.
export class IntegrationsManifestInvalidError extends Error {
  readonly issues: ReadonlyArray<IntegrationsManifestIssue>;
  constructor(issues: ReadonlyArray<IntegrationsManifestIssue>) {
    const summary = issues.map((issue) => `${issue.path || "<root>"}: ${issue.message}`).join("; ");
    super(`invalid .tanren/integrations.yml: ${summary}`);
    this.name = "IntegrationsManifestInvalidError";
    this.issues = issues;
  }
}

function issuesFromZod(error: z.ZodError): IntegrationsManifestIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length === 0 ? "<root>" : issue.path.join("."),
    message: issue.message,
  }));
}

// Parse + validate raw YAML text into a typed manifest. `undefined` (no file in the
// repo) resolves to `undefined` — a project that declares no integrations, which is a
// semantic absence, not an error. A PRESENT-but-empty / comment-only document parses
// to an empty mapping and FAILS the schema (apiVersion / version / integrations are
// required) — declaring the file with nothing in it is a loud mistake, never a
// silent no-op. Throws `IntegrationsManifestInvalidError` on any syntax or schema
// violation.
export function resolveIntegrationsManifest(yamlText: string | undefined): IntegrationsManifestV1 | undefined {
  if (yamlText === undefined) {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (error) {
    if (error instanceof CiYamlParseError) {
      throw new IntegrationsManifestInvalidError([{ path: `line ${error.line}`, message: yamlMessage(error) }]);
    }
    throw new IntegrationsManifestInvalidError([
      { path: "<root>", message: error instanceof Error ? error.message : String(error) },
    ]);
  }
  const result = IntegrationsManifestV1Schema.safeParse(raw);
  if (!result.success) {
    throw new IntegrationsManifestInvalidError(issuesFromZod(result.error));
  }
  return result.data;
}

// Strip the ci.yml-specific prefix off the reused YAML parser's message so the
// integrations context is not misreported (the parser is generic; only its error
// label names ci.yml).
function yamlMessage(error: CiYamlParseError): string {
  return error.message.replace(/^tanren-ci\.yml parse error \(line \d+\):\s*/u, "").trim() || "YAML parse error";
}

// Project a validated manifest onto the in-7 integration-fragment selection config —
// the input the derive seam (`resolveIntegrationFragments`) consumes. Each declared
// integration maps 1:1 to its provider-integration fragment identity
// (`capability:provider@version`); the manifest's richer per-entry declaration
// (operations / scopes / environments / direction / criticality) is carried on the
// typed manifest for the downstream capability-prepare phase (in-9/in-10). Re-parses
// through `IntegrationFragmentConfigSchema` so the projection is itself validated
// (unique fragment ids) — a defensive belt over the manifest's own identity check.
export function integrationFragmentConfigFromManifest(manifest: IntegrationsManifestV1): IntegrationFragmentConfig {
  return IntegrationFragmentConfigSchema.parse({
    apiVersion: "tanren.dev/integration-fragments/v1",
    schemaVersion: 1,
    fragments: manifest.integrations.map((entry) => ({
      capability: entry.capability,
      providerKind: entry.provider,
      plane: entry.plane,
      version: entry.providerVersion,
    })),
  });
}
