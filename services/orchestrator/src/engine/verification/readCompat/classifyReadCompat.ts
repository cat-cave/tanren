// rv-22 — the read-compat classifier. Given a committed BASELINE (the published
// compatibility floor) and the CURRENT rendered JSON Schemas of the read surface,
// it classifies every structural difference as either backward-COMPATIBLE
// (additive — a new field / a new enum member / a new schema) or backward-
// INCOMPATIBLE (breaking — a removed / renamed / retyped field, a removed enum
// member, a weakened required guarantee, a dropped schema). A rename surfaces as a
// removed property (the old name) plus an added property (the new name), so the
// removed old name trips the breaking arm.
//
// This is a PURE function (no I/O) so both scripts/rv-read-compat.mjs (the CI
// guard) and the vitest unit test drive it. The guard sets `compatible === false`
// as its non-zero exit condition, so an incompatible change fails CI while an
// additive one passes untouched.

export type JsonSchemaNode = Record<string, unknown>;
export type SchemaMap = Record<string, JsonSchemaNode>;

export type BreakingKind =
  | "removed-schema"
  | "removed-property"
  | "type-changed"
  | "removed-enum-value"
  | "weakened-required";
export type AdditiveKind = "added-schema" | "added-property" | "added-enum-value";

export interface BreakingChange {
  readonly schema: string;
  readonly path: string;
  readonly kind: BreakingKind;
  readonly detail: string;
}
export interface AdditiveChange {
  readonly schema: string;
  readonly path: string;
  readonly kind: AdditiveKind;
  readonly detail: string;
}
export interface ReadCompatResult {
  readonly compatible: boolean;
  readonly breaking: readonly BreakingChange[];
  readonly additive: readonly AdditiveChange[];
}

function isObject(value: unknown): value is JsonSchemaNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The set of JSON-Schema primitive types a node admits (handles `type` as a
 * string, `type` as an array (nullable), and the anyOf/oneOf union Zod emits for
 * nullable/optional). Returns an empty set for an untyped node ({} — "any"). */
function typeSet(node: JsonSchemaNode): Set<string> {
  const out = new Set<string>();
  const type = node["type"];
  if (typeof type === "string") out.add(type);
  else if (Array.isArray(type)) for (const t of type) if (typeof t === "string") out.add(t);
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = node[key];
    if (Array.isArray(branches)) {
      for (const branch of branches) if (isObject(branch)) for (const t of typeSet(branch)) out.add(t);
    }
  }
  return out;
}

function properties(node: JsonSchemaNode): Record<string, JsonSchemaNode> {
  const props = node["properties"];
  return isObject(props) ? (props as Record<string, JsonSchemaNode>) : {};
}

function requiredSet(node: JsonSchemaNode): Set<string> {
  const req = node["required"];
  return new Set(Array.isArray(req) ? req.filter((v): v is string => typeof v === "string") : []);
}

function enumValues(node: JsonSchemaNode): unknown[] | undefined {
  const values = node["enum"];
  return Array.isArray(values) ? values : undefined;
}

/** Recurse into the one place a node holds a child schema for array items. */
function itemsOf(node: JsonSchemaNode): JsonSchemaNode | undefined {
  const items = node["items"];
  return isObject(items) ? items : undefined;
}

function compareNode(
  schema: string,
  path: string,
  base: JsonSchemaNode,
  current: JsonSchemaNode,
  breaking: BreakingChange[],
  additive: AdditiveChange[],
): void {
  // Type compatibility: any primitive type the CURRENT node introduces that the
  // BASELINE did not admit is a widening/retype a strict consumer can break on.
  const baseTypes = typeSet(base);
  const curTypes = typeSet(current);
  if (baseTypes.size > 0) {
    for (const t of curTypes) {
      if (!baseTypes.has(t)) {
        breaking.push({
          schema,
          path,
          kind: "type-changed",
          detail: `type widened to include '${t}' (baseline: ${[...baseTypes].join("|") || "any"})`,
        });
      }
    }
  }

  // Enum members: a removed value is breaking (a consumer's exhaustive match loses
  // a case guarantee only if it grows, but a value the server used to emit and now
  // cannot is a contract narrowing — treat a removed member as breaking so the
  // published closed set cannot silently shrink); a new value is additive.
  const baseEnum = enumValues(base);
  const curEnum = enumValues(current);
  if (baseEnum !== undefined && curEnum !== undefined) {
    const curEnumSet = new Set(curEnum.map((v) => JSON.stringify(v)));
    const baseEnumSet = new Set(baseEnum.map((v) => JSON.stringify(v)));
    for (const v of baseEnum) {
      if (!curEnumSet.has(JSON.stringify(v))) {
        breaking.push({ schema, path, kind: "removed-enum-value", detail: `enum value ${JSON.stringify(v)} removed` });
      }
    }
    for (const v of curEnum) {
      if (!baseEnumSet.has(JSON.stringify(v))) {
        additive.push({ schema, path, kind: "added-enum-value", detail: `enum value ${JSON.stringify(v)} added` });
      }
    }
  }

  // Object properties.
  const baseProps = properties(base);
  const curProps = properties(current);
  const basePropNames = Object.keys(baseProps);
  if (basePropNames.length > 0 || Object.keys(curProps).length > 0) {
    for (const name of basePropNames) {
      const childPath = `${path}.${name}`;
      const curChild = curProps[name];
      if (curChild === undefined) {
        breaking.push({ schema, path: childPath, kind: "removed-property", detail: `property '${name}' removed` });
        continue;
      }
      compareNode(schema, childPath, baseProps[name] as JsonSchemaNode, curChild, breaking, additive);
    }
    for (const name of Object.keys(curProps)) {
      if (baseProps[name] === undefined) {
        additive.push({ schema, path: `${path}.${name}`, kind: "added-property", detail: `property '${name}' added` });
      }
    }
    // A property the baseline guaranteed present (required) that the current shape
    // no longer requires weakens the read guarantee consumers depend on.
    const baseRequired = requiredSet(base);
    const curRequired = requiredSet(current);
    for (const name of baseRequired) {
      if (curProps[name] !== undefined && !curRequired.has(name)) {
        breaking.push({
          schema,
          path: `${path}.${name}`,
          kind: "weakened-required",
          detail: `property '${name}' is no longer required`,
        });
      }
    }
  }

  // Array items.
  const baseItems = itemsOf(base);
  const curItems = itemsOf(current);
  if (baseItems !== undefined && curItems !== undefined) {
    compareNode(schema, `${path}[]`, baseItems, curItems, breaking, additive);
  }
}

/**
 * Classify current-vs-baseline. `compatible` is true iff there are zero breaking
 * changes (additive changes are always allowed). Every schema the baseline
 * published must still exist; a new schema is additive.
 */
export function classifyReadCompat(baseline: SchemaMap, current: SchemaMap): ReadCompatResult {
  const breaking: BreakingChange[] = [];
  const additive: AdditiveChange[] = [];

  for (const [schema, baseNode] of Object.entries(baseline)) {
    const curNode = current[schema];
    if (curNode === undefined) {
      breaking.push({ schema, path: "$", kind: "removed-schema", detail: `schema '${schema}' removed` });
      continue;
    }
    compareNode(schema, "$", baseNode, curNode, breaking, additive);
  }
  for (const schema of Object.keys(current)) {
    if (baseline[schema] === undefined) {
      additive.push({ schema, path: "$", kind: "added-schema", detail: `schema '${schema}' added` });
    }
  }

  return { compatible: breaking.length === 0, breaking, additive };
}
