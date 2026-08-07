export type ParsedLinkValue = { target: string; parameters: ReadonlyMap<string, string> };
export class LinkHeaderError extends Error {}
function malformed(detail: string): never {
  throw new LinkHeaderError(detail);
}
function splitOutside(input: string, delimiter: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  let inAngle = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "<") inAngle = true;
    else if (char === ">") inAngle = false;
    else if (char === delimiter && !inAngle) {
      parts.push(input.slice(start, index));
      start = index + 1;
    }
  }
  if (quoted || inAngle) return malformed("unterminated quoted value or target");
  parts.push(input.slice(start));
  return parts;
}
export function parseLinkHeader(header: string): ParsedLinkValue[] {
  return splitOutside(header, ",").map((rawValue) => {
    const parsedValue = /^<([^<>]+)>(.*)$/u.exec(rawValue.trim());
    if (parsedValue === null) return malformed("invalid link target");
    const tail = parsedValue[2]!.trim();
    if (tail !== "" && !tail.startsWith(";")) return malformed("invalid parameter separator");
    const parameters = new Map<string, string>();
    for (const rawParameter of tail === "" ? [] : splitOutside(tail.slice(1), ";")) {
      const parsed =
        /^\s*([!#$%&'*+\-.^_`|~A-Za-z0-9]+)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([!#$%&'*+\-.^_`|~A-Za-z0-9:]+))\s*$/u.exec(
          rawParameter,
        );
      if (parsed === null) return malformed("invalid parameter");
      const name = parsed[1]!.toLowerCase();
      if (parameters.has(name)) return malformed("duplicate parameter name");
      parameters.set(name, (parsed[2] ?? parsed[3])!.replaceAll(/\\(.)/gu, "$1"));
    }
    return { target: parsedValue[1]!, parameters };
  });
}
