// Single import surface for Tanren-native templating (wave 1) — the template
// OBJECT: the `.tanren/template.yml` manifest schema + its fail-loud parser. The
// registry STORE rides on the `Repositories` seam (engine/repositories/
// templates.ts); the operator routes live under routes/templates. Contract +
// parser only — no validation, no gate execution (later waves own those).
export {
  NegativeControlResult,
  TemplateCapabilities,
  TemplateChannel,
  TemplateManifestV1,
  TemplateManifestValidationError,
  TemplateManifestYamlParseError,
  TemplateProvenance,
  TemplateValidationProof,
  manifestToJson,
  parseTemplateManifest,
} from "./manifest.js";
