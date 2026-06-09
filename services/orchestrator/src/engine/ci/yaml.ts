// Minimal, dependency-free YAML parser scoped to the shapes `tanren-ci.yml`
// needs: nested mappings, sequences of mappings/scalars, and scalar values
// (quoted or bare). It is intentionally NOT a general YAML implementation —
// the orchestrator has no YAML dependency in the lockfile, and adding one for
// a single constrained config file is not justified. Anything outside this
// supported subset raises CiYamlParseError so the validator fails loudly.

export class CiYamlParseError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`tanren-ci.yml parse error (line ${line}): ${message}`);
    this.name = "CiYamlParseError";
    this.line = line;
  }
}

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

interface Line {
  readonly indent: number;
  readonly content: string;
  readonly number: number;
}

// Strip comments (a `#` not inside quotes) and trailing whitespace, drop blank
// lines, and reject tab INDENTATION (YAML forbids tabs for indentation).
function tokenize(text: string): Line[] {
  const lines: Line[] = [];
  text.split("\n").forEach((raw, index) => {
    const number = index + 1;
    // §3.12: reject a tab only in the INDENTATION REGION (the leading whitespace), NOT
    // anywhere in the line. The old check (`raw.includes("\t") && line is indented`) flagged
    // a tab INSIDE a quoted string on any indented line as "tab indentation" — a false
    // reject of valid content (e.g. a `run:` value that contains a literal tab). A tab in
    // the leading run of whitespace IS forbidden indentation; a tab after the first
    // non-whitespace char is content.
    const leadingWhitespace = raw.slice(0, raw.length - raw.trimStart().length);
    if (leadingWhitespace.includes("\t")) {
      throw new CiYamlParseError("tab indentation is not allowed", number);
    }
    const stripped = stripComment(raw);
    if (stripped.trim().length === 0) {
      return;
    }
    const indent = stripped.length - stripped.trimStart().length;
    lines.push({ indent, content: stripped.trim(), number });
  });
  return lines;
}

function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#" && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseScalar(raw: string, line: number): YamlValue {
  const value = raw.trim();
  if (value.length === 0) {
    throw new CiYamlParseError("empty scalar value", line);
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    if (value.length < 2) {
      throw new CiYamlParseError("unterminated quoted string", line);
    }
    return value.slice(1, -1);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  if (/^-?\d+$/u.test(value)) return Number.parseInt(value, 10);
  if (/^-?\d+\.\d+$/u.test(value)) return Number.parseFloat(value);
  return value;
}

// Recursive-descent over the indented line list. `block` consumes every line
// at exactly `indent`, returning the parsed mapping or sequence at that level
// plus the index of the first line that belongs to a shallower level.
function block(lines: Line[], start: number, indent: number): { value: YamlValue; next: number } {
  const first = lines[start];
  if (first === undefined || first.indent < indent) {
    throw new CiYamlParseError("expected content but found none", first?.number ?? 0);
  }
  return first.content.startsWith("- ") || first.content === "-"
    ? sequence(lines, start, indent)
    : mapping(lines, start, indent);
}

function sequence(lines: Line[], start: number, indent: number): { value: YamlValue; next: number } {
  const items: YamlValue[] = [];
  let i = start;
  for (
    let line = lines[i];
    line !== undefined && line.indent === indent && (line.content === "-" || line.content.startsWith("- "));
    line = lines[i]
  ) {
    const rest = line.content === "-" ? "" : line.content.slice(2).trim();
    if (rest.length === 0) {
      const result = block(lines, i + 1, indent + 2);
      items.push(result.value);
      i = result.next;
    } else if (rest.includes(":") && !isFlowQuotedColon(rest)) {
      // Inline first key of a mapping item: re-tokenize the item body so the
      // mapping parser sees the first pair at the item's content indent.
      const result = inlineMappingItem(lines, i, indent, rest);
      items.push(result.value);
      i = result.next;
    } else {
      items.push(parseScalar(rest, line.number));
      i += 1;
    }
  }
  return { value: items, next: i };
}

// Handles `- name: value` where subsequent sibling keys are indented under the
// dash. We synthesize a mapping starting from the inline pair plus any deeper
// lines that follow before the next sequence item.
function inlineMappingItem(
  lines: Line[],
  start: number,
  indent: number,
  rest: string,
): { value: YamlValue; next: number } {
  const keyIndent = indent + 2;
  const startLine = lines[start];
  if (startLine === undefined) {
    throw new CiYamlParseError("expected a sequence item line", 0);
  }
  const synthesized: Line[] = [{ indent: keyIndent, content: rest, number: startLine.number }];
  let i = start + 1;
  for (let next = lines[i]; next !== undefined && next.indent >= keyIndent; next = lines[i]) {
    synthesized.push(next);
    i += 1;
  }
  const result = mapping(synthesized, 0, keyIndent);
  return { value: result.value, next: i };
}

function isFlowQuotedColon(rest: string): boolean {
  return (rest.startsWith('"') && rest.endsWith('"')) || (rest.startsWith("'") && rest.endsWith("'"));
}

function mapping(lines: Line[], start: number, indent: number): { value: YamlValue; next: number } {
  const obj: { [key: string]: YamlValue } = {};
  let i = start;
  for (let line = lines[i]; line !== undefined && line.indent === indent; line = lines[i]) {
    if (line.content.startsWith("- ") || line.content === "-") {
      break;
    }
    const colon = findKeyColon(line.content, line.number);
    const key = parseKey(line.content.slice(0, colon), line.number);
    // §3.12 DUPLICATE-KEY: a YAML mapping must not declare the same key twice. The old
    // last-wins (`obj[key] = ...` overwrite) silently dropped the earlier value — a
    // writer-editable ci.yml could shadow an earlier `when`/`tiers` entry, e.g. quietly
    // redefining the `pre_merge` mapping. Fail LOUDLY so an ambiguous config never parses.
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      throw new CiYamlParseError(`duplicate mapping key "${key}"`, line.number);
    }
    const valueText = line.content.slice(colon + 1).trim();
    if (valueText.length > 0) {
      obj[key] = parseScalar(valueText, line.number);
      i += 1;
    } else {
      const childIndent = lines[i + 1]?.indent ?? indent;
      const result = block(lines, i + 1, childIndent > indent ? childIndent : indent + 2);
      obj[key] = result.value;
      i = result.next;
    }
  }
  return { value: obj, next: i };
}

function findKeyColon(content: string, line: number): number {
  let quote: string | null = null;
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ":" && (i + 1 === content.length || content[i + 1] === " ")) {
      return i;
    }
  }
  throw new CiYamlParseError("expected a mapping key (missing ':')", line);
}

function parseKey(raw: string, line: number): string {
  const value = parseScalar(raw, line);
  if (typeof value !== "string") {
    throw new CiYamlParseError("mapping keys must be strings", line);
  }
  return value;
}

// Parse a YAML document into a plain JS value. Empty input yields an empty
// mapping. Callers (the loader) hand the result to Zod for validation.
export function parseYaml(text: string): YamlValue {
  const lines = tokenize(text);
  if (lines.length === 0) {
    return {};
  }
  const firstLine = lines[0];
  if (firstLine === undefined || firstLine.indent !== 0) {
    throw new CiYamlParseError("document must start at column 0", firstLine?.number ?? 0);
  }
  const result = block(lines, 0, 0);
  if (result.next !== lines.length) {
    throw new CiYamlParseError("inconsistent indentation", lines[result.next]?.number ?? 0);
  }
  return result.value;
}
