export type ParsedLinkValue = { target: string; parameters: ReadonlyMap<string, string> };
export class LinkHeaderError extends Error {}
function malformed(detail: string): never {
  throw new LinkHeaderError(detail);
}
export function parseLinkHeader(header: string): ParsedLinkValue[] {
  return header.split(/,\s*(?=<)/u).map((rawValue) => {
    const parsedValue = /^<([^<>]+)>(.*)$/u.exec(rawValue.trim());
    if (parsedValue === null) return malformed("invalid link target");
    const tail = parsedValue[2]!.trim();
    if (tail !== "" && !tail.startsWith(";")) return malformed("invalid parameter separator");
    const parameters = new Map<string, string>();
    for (const rawParameter of tail === "" ? [] : tail.slice(1).split(";")) {
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
