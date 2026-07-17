// ds-1 — deterministic DTCG token parsing and base/plain resolution.
//
// This core intentionally has no filesystem, database, or provider dependency.
// It supports DTCG's complete-token `{group.token}` aliases and RFC 6901 JSON
// Pointer `$ref` aliases, including chained references and property references.

import type { DesignSystemBaseComposedEvent, DesignSystemCoreEventEmitter } from "./designSystemCoreEvents.js";

export type DtcgResolutionMode = "base/plain";

export type DtcgValue = null | boolean | number | string | readonly DtcgValue[] | { readonly [key: string]: DtcgValue };

export interface DtcgToken {
  /** Dot-separated paths are valid because DTCG token/group names cannot contain dots. */
  readonly path: readonly string[];
  /** JSON Pointer location of this token in its source document. */
  readonly pointer: string;
  readonly type?: string;
  readonly value?: DtcgValue;
  readonly ref?: string;
}

export interface DtcgDocument {
  readonly root: DtcgValue;
  readonly tokens: readonly DtcgToken[];
}

export interface ResolvedDtcgToken {
  readonly path: readonly string[];
  readonly pointer: string;
  readonly type?: string;
  readonly value: DtcgValue;
}

export interface DtcgResolution {
  readonly mode: DtcgResolutionMode;
  readonly tokens: readonly ResolvedDtcgToken[];
  tokenAt(path: readonly string[] | string): ResolvedDtcgToken | undefined;
}

/** Shared typed shape of all deterministic DTCG parser/resolver failures. */
export interface DtcgError extends Error {
  readonly code: string;
}

export function isDtcgError(error: unknown): error is DtcgError {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}

/** The document is not structurally valid DTCG for base/plain processing. */
export class DtcgDocumentError extends Error implements DtcgError {
  readonly code = "design.dtcg.document_invalid";

  constructor(
    readonly path: string,
    issue: string,
  ) {
    super(`DTCG document at '${path}' is invalid: ${issue}`);
    this.name = "DtcgDocumentError";
  }
}

/** A reference points to no token/location in the document. */
export class DtcgUnresolvedReferenceError extends Error implements DtcgError {
  readonly code = "design.dtcg.reference_missing";

  constructor(
    readonly reference: string,
    readonly from: string,
  ) {
    super(`DTCG reference '${reference}' from '${from}' does not resolve`);
    this.name = "DtcgUnresolvedReferenceError";
  }
}

/** A reference uses invalid curly-brace or JSON Pointer syntax. */
export class DtcgMalformedPointerError extends Error implements DtcgError {
  readonly code = "design.dtcg.reference_malformed";

  constructor(
    readonly reference: string,
    readonly from: string,
    issue: string,
  ) {
    super(`DTCG reference '${reference}' from '${from}' is malformed: ${issue}`);
    this.name = "DtcgMalformedPointerError";
  }
}

/** A chain of aliases resolves back to a token already being resolved. */
export class DtcgReferenceCycleError extends Error implements DtcgError {
  readonly code = "design.dtcg.reference_cycle";

  constructor(readonly cycle: readonly string[]) {
    super(`DTCG reference cycle: ${cycle.join(" -> ")}`);
    this.name = "DtcgReferenceCycleError";
  }
}

/** An alias declares a type incompatible with the token it aliases. */
export class DtcgReferenceTypeMismatchError extends Error implements DtcgError {
  readonly code = "design.dtcg.reference_type_mismatch";

  constructor(
    readonly from: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`DTCG token '${from}' declares type '${expected}' but its reference resolves '${actual}'`);
    this.name = "DtcgReferenceTypeMismatchError";
  }
}

export interface ComposePlainDtcgInput {
  readonly document: unknown;
  readonly event: DesignSystemBaseComposedEvent;
  readonly eventEmitter?: DesignSystemCoreEventEmitter;
}

/** Parse a JSON-shaped document into its deterministic token index. */
export function parseDtcgDocument(value: unknown): DtcgDocument {
  assertJson(value, "#");
  if (!isObject(value)) {
    throw new DtcgDocumentError("#", "the root must be an object");
  }
  const tokens: DtcgToken[] = [];
  visitGroup(value, [], [], undefined, tokens);
  if (tokens.length === 0) {
    throw new DtcgDocumentError("#", "the document must declare at least one token");
  }
  return { root: cloneValue(value), tokens };
}

/** Resolve a parsed document in the deliberately context-free base/plain mode. */
export function resolveDtcgDocument(document: DtcgDocument, mode: DtcgResolutionMode = "base/plain"): DtcgResolution {
  const tokensByPath = new Map(document.tokens.map((token) => [pathKey(token.path), token]));
  const tokensByPointer = new Map<string, DtcgToken>();
  for (const token of document.tokens) {
    tokensByPointer.set(token.pointer, token);
    tokensByPointer.set(`${token.pointer}/$value`, token);
  }
  const states = new Map<string, "resolving" | "resolved">();
  const cache = new Map<string, ResolvedDtcgToken>();
  const stack: string[] = [];

  const resolveToken = (token: DtcgToken): ResolvedDtcgToken => {
    const key = pathKey(token.path);
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    if (states.get(key) === "resolving") {
      const start = stack.indexOf(tokenName(token.path));
      throw new DtcgReferenceCycleError([...stack.slice(start), tokenName(token.path)]);
    }
    states.set(key, "resolving");
    stack.push(tokenName(token.path));
    try {
      const valueReference =
        token.value !== undefined && isAliasReference(token.value) ? resolveReference(token.value, token) : undefined;
      const target = token.ref === undefined ? valueReference : resolveReference(token.ref, token);
      const resolved = {
        path: [...token.path],
        pointer: token.pointer,
        type: token.type ?? target?.type,
        value: cloneValue(
          token.value === undefined
            ? (target?.value ?? failMissingValue(token))
            : (valueReference?.value ?? resolveValue(token.value, token)),
        ),
      };
      if (token.type !== undefined && target?.type !== undefined && token.type !== target.type) {
        throw new DtcgReferenceTypeMismatchError(tokenName(token.path), token.type, target.type);
      }
      cache.set(key, resolved);
      states.set(key, "resolved");
      return resolved;
    } finally {
      stack.pop();
      if (states.get(key) === "resolving") states.delete(key);
    }
  };

  const resolveReference = (
    reference: string,
    from: DtcgToken,
  ): ResolvedDtcgToken | { readonly value: DtcgValue; readonly type?: string } => {
    if (reference.startsWith("{")) {
      const path = parseAliasPath(reference, tokenName(from.path));
      const target = tokensByPath.get(pathKey(path));
      if (target === undefined) throw new DtcgUnresolvedReferenceError(reference, tokenName(from.path));
      return resolveToken(target);
    }
    const pointer = parsePointer(reference, tokenName(from.path));
    const directToken = tokensByPointer.get(reference);
    if (directToken !== undefined) return resolveToken(directToken);
    const found = pointerAt(document.root, pointer, reference, tokenName(from.path));
    return { value: resolveValue(found, from) };
  };

  const resolveValue = (value: DtcgValue, from: DtcgToken): DtcgValue => {
    if (typeof value === "string") {
      if (value.startsWith("{") || value.endsWith("}")) {
        return cloneValue(resolveReference(value, from).value);
      }
      return value;
    }
    if (Array.isArray(value)) return value.map((item) => resolveValue(item, from));
    if (isObject(value)) {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, resolveValue(item, from)]),
      );
    }
    return value;
  };

  const resolved = document.tokens
    .map(resolveToken)
    .sort((left, right) => tokenName(left.path).localeCompare(tokenName(right.path)));
  return {
    mode,
    tokens: resolved,
    tokenAt: (path) => {
      const token = cache.get(pathKey(typeof path === "string" ? parseTokenPath(path) : path));
      return token === undefined ? undefined : cloneToken(token);
    },
  };
}

/** Parse and resolve a raw DTCG document in one deterministic operation. */
export function resolveDtcgTokens(value: unknown, mode: DtcgResolutionMode = "base/plain"): DtcgResolution {
  return resolveDtcgDocument(parseDtcgDocument(value), mode);
}

/** Resolve the plain base and emit the existing frozen base-composed event through an injected seam. */
export function composePlainDtcgTokens(input: ComposePlainDtcgInput): DtcgResolution {
  const resolution = resolveDtcgTokens(input.document);
  input.eventEmitter?.emit({ type: "designSystem.base.composed", payload: input.event });
  return resolution;
}

function visitGroup(
  node: Record<string, DtcgValue>,
  tokenPath: readonly string[],
  pointerPath: readonly string[],
  inheritedType: string | undefined,
  tokens: DtcgToken[],
): void {
  if (isTokenNode(node)) {
    if (tokenPath.length === 0) throw new DtcgDocumentError("#", "the root cannot itself be a token");
    tokens.push(parseToken(node, tokenPath, pointerPath, inheritedType));
    return;
  }
  validateGroupProperties(node, pointerPath);
  const groupType = readType(node, pointerPath) ?? inheritedType;
  const root = node["$root"];
  if (root !== undefined) {
    if (!isObject(root) || !isTokenNode(root))
      throw new DtcgDocumentError(pointerName([...pointerPath, "$root"]), "$root must be a token");
    tokens.push(parseToken(root, tokenPath, [...pointerPath, "$root"], groupType));
  }
  for (const key of Object.keys(node).sort()) {
    if (key.startsWith("$")) continue;
    assertName(key, [...pointerPath, key]);
    const child = node[key];
    if (!isObject(child))
      throw new DtcgDocumentError(pointerName([...pointerPath, key]), "a token/group must be an object");
    visitGroup(child, [...tokenPath, key], [...pointerPath, key], groupType, tokens);
  }
}

function parseToken(
  node: Record<string, DtcgValue>,
  path: readonly string[],
  pointerPath: readonly string[],
  inheritedType: string | undefined,
): DtcgToken {
  validateTokenProperties(node, pointerPath);
  const hasValue = Object.hasOwn(node, "$value");
  const hasRef = Object.hasOwn(node, "$ref");
  if (hasValue === hasRef)
    throw new DtcgDocumentError(pointerName(pointerPath), "a token must have exactly one of $value or $ref");
  const ref = node["$ref"];
  const common = {
    path: [...path],
    pointer: pointerName(pointerPath),
    type: readType(node, pointerPath) ?? inheritedType,
  };
  if (hasValue) {
    const value = node["$value"];
    if (value === undefined) throw new DtcgDocumentError(pointerName(pointerPath), "$value must be JSON-compatible");
    return { ...common, value: cloneValue(value) };
  }
  if (typeof ref !== "string") throw new DtcgDocumentError(pointerName(pointerPath), "$ref must be a string");
  return { ...common, ref };
}

function validateGroupProperties(node: Record<string, DtcgValue>, pointerPath: readonly string[]): void {
  for (const key of Object.keys(node)) {
    if (!key.startsWith("$")) continue;
    if (!["$schema", "$type", "$description", "$extensions", "$deprecated", "$root"].includes(key)) {
      throw new DtcgDocumentError(pointerName(pointerPath), `unsupported group property '${key}' in base/plain mode`);
    }
  }
  if (node["$schema"] !== undefined && typeof node["$schema"] !== "string") {
    throw new DtcgDocumentError(pointerName(pointerPath), "$schema must be a string");
  }
  validateCommonProperties(node, pointerPath);
}

function validateTokenProperties(node: Record<string, DtcgValue>, pointerPath: readonly string[]): void {
  for (const key of Object.keys(node)) {
    if (!key.startsWith("$")) continue;
    if (!["$type", "$description", "$extensions", "$deprecated", "$value", "$ref"].includes(key)) {
      throw new DtcgDocumentError(pointerName(pointerPath), `unsupported token property '${key}' in base/plain mode`);
    }
  }
  validateCommonProperties(node, pointerPath);
}

function validateCommonProperties(node: Record<string, DtcgValue>, pointerPath: readonly string[]): void {
  readType(node, pointerPath);
  if (node["$description"] !== undefined && typeof node["$description"] !== "string") {
    throw new DtcgDocumentError(pointerName(pointerPath), "$description must be a string");
  }
  if (
    node["$deprecated"] !== undefined &&
    typeof node["$deprecated"] !== "boolean" &&
    typeof node["$deprecated"] !== "string"
  ) {
    throw new DtcgDocumentError(pointerName(pointerPath), "$deprecated must be a boolean or string");
  }
  if (node["$extensions"] !== undefined && !isObject(node["$extensions"])) {
    throw new DtcgDocumentError(pointerName(pointerPath), "$extensions must be an object");
  }
}

function readType(node: Record<string, DtcgValue>, pointerPath: readonly string[]): string | undefined {
  const type = node["$type"];
  if (type === undefined) return undefined;
  if (typeof type !== "string" || type.length === 0) {
    throw new DtcgDocumentError(pointerName(pointerPath), "$type must be a non-empty string");
  }
  return type;
}

function parseAliasPath(reference: string, from: string): string[] {
  const match = /^\{([^{}]+)\}$/u.exec(reference);
  if (match?.[1] === undefined)
    throw new DtcgMalformedPointerError(reference, from, "expected a complete {token.path} alias");
  const path = match[1].split(".");
  if (path.some((segment) => segment.length === 0)) {
    throw new DtcgMalformedPointerError(reference, from, "alias path has an empty segment");
  }
  return path;
}

function isAliasReference(value: DtcgValue): value is string {
  return typeof value === "string" && (value.startsWith("{") || value.endsWith("}"));
}

function parsePointer(reference: string, from: string): string[] {
  if (reference === "#") return [];
  if (!reference.startsWith("#/"))
    throw new DtcgMalformedPointerError(reference, from, "expected an RFC 6901 fragment beginning '#/'");
  return reference
    .slice(2)
    .split("/")
    .map((segment) => unescapePointerSegment(segment, reference, from));
}

function unescapePointerSegment(segment: string, reference: string, from: string): string {
  for (let index = 0; index < segment.length; index += 1) {
    if (segment[index] === "~" && segment[index + 1] !== "0" && segment[index + 1] !== "1") {
      throw new DtcgMalformedPointerError(reference, from, "'~' must be escaped as '~0' or '~1'");
    }
  }
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function pointerAt(root: DtcgValue, path: readonly string[], reference: string, from: string): DtcgValue {
  let current = root;
  for (const segment of path) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/u.test(segment)) throw new DtcgUnresolvedReferenceError(reference, from);
      const item = current[Number(segment)];
      if (item === undefined) throw new DtcgUnresolvedReferenceError(reference, from);
      current = item;
      continue;
    }
    if (!isObject(current) || !Object.hasOwn(current, segment)) throw new DtcgUnresolvedReferenceError(reference, from);
    const next = current[segment];
    if (next === undefined) throw new DtcgUnresolvedReferenceError(reference, from);
    current = next;
  }
  return current;
}

function assertJson(value: unknown, pointer: string): asserts value is DtcgValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new DtcgDocumentError(pointer, "numbers must be finite JSON numbers");
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJson(item, `${pointer}/${index}`));
    return;
  }
  if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) assertJson(item, `${pointer}/${escapePointerSegment(key)}`);
    return;
  }
  throw new DtcgDocumentError(pointer, "values must be JSON-compatible");
}

function isObject(value: unknown): value is { readonly [key: string]: DtcgValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTokenNode(node: Record<string, DtcgValue>): boolean {
  return Object.hasOwn(node, "$value") || Object.hasOwn(node, "$ref");
}

function assertName(name: string, pointerPath: readonly string[]): void {
  if (name.startsWith("$") || /[.{}]/u.test(name)) {
    throw new DtcgDocumentError(
      pointerName(pointerPath),
      "token and group names cannot start with '$' or contain '.', '{', or '}'",
    );
  }
}

function cloneValue(value: DtcgValue): DtcgValue {
  if (Array.isArray(value)) return value.map((item) => cloneValue(item));
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, cloneValue(item)]),
    );
  }
  return value;
}

function cloneToken(token: ResolvedDtcgToken): ResolvedDtcgToken {
  return { ...token, path: [...token.path], value: cloneValue(token.value) };
}

function tokenName(path: readonly string[]): string {
  return path.join(".");
}

function pathKey(path: readonly string[]): string {
  return JSON.stringify(path);
}

function parseTokenPath(path: string): string[] {
  return path.split(".");
}

function pointerName(path: readonly string[]): string {
  return path.length === 0 ? "#" : `#/${path.map((segment) => escapePointerSegment(segment)).join("/")}`;
}

function escapePointerSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function failMissingValue(token: DtcgToken): never {
  throw new DtcgDocumentError(token.pointer, "token has no resolvable value");
}
