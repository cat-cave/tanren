// `jj config set <NAME> <VALUE>` parses <VALUE> as a TOML EXPRESSION, not as a raw
// string (jj 0.42: "The value should be specified as a TOML expression. If string value
// isn't enclosed by any TOML constructs ... quotes can be omitted"). A bare value that
// happens to START a TOML construct is therefore a PARSE ERROR, not a literal — the
// archetype is a GitHub App bot identity like `tanren-cat-cave-validation[bot]`, whose
// `[` opens a TOML array/table header:
//
//   jj config set --repo user.name 'tanren-cat-cave-validation[bot]'
//   error: invalid value 'tanren-cat-cave-validation[bot]' ...
//     TOML parse error at line 1, column 27 — unexpected content, expected nothing
//
// On the live delivery path that fails on EVERY conflict-resolve/merge (deterministic),
// so the native merge-queue batch coordinator hits `WorkspaceCommandError` →
// `merge.batch.infra_blocked` → holds + retries forever → the run never converges. Any
// value with a TOML-special leading char (`[`, `{`, `'`, `"`, a leading digit/`+`/`-`
// that reads as a number, ...) breaks the same way. jj 0.42 has NO non-TOML-parsing
// flag (`jj config set --help` exposes only `<VALUE>`), so the version-robust fix is to
// always hand jj an explicitly TOML-QUOTED basic string — making the value
// unambiguously a string regardless of its contents.

/**
 * Encode an arbitrary value as a TOML BASIC STRING (double-quoted, with the escapes TOML
 * basic strings require), so it is a valid `jj config set` <VALUE> for ANY input. The
 * returned text is the literal TOML the shell argument must carry — e.g.
 * `tanren-cat-cave-validation[bot]` → `"tanren-cat-cave-validation[bot]"`. jj parses the
 * quoted string and stores the literal value (the surrounding quotes do NOT leak into the
 * stored name/email — verified on a real jj 0.42 runner).
 *
 * This is the TOML-VALUE layer only; the result still passes through
 * {@link quoteSshShellArg} for the SHELL layer (the two quoting concerns are orthogonal).
 *
 * Escapes per the TOML basic-string grammar: `\` and `"` are backslash-escaped; the
 * control characters TOML names get their compact escapes (`\b \t \n \f \r`); any other
 * control char (U+0000–U+001F, U+007F) is emitted as a `\uXXXX` short escape. Everything
 * else (including the `[`/`]`/`+`/`@` of a bot identity, and all printable Unicode) is
 * passed through verbatim — those are legal inside a basic string.
 */
export function toTomlString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    switch (ch) {
      case "\\":
        out += "\\\\";
        break;
      case '"':
        out += '\\"';
        break;
      case "\b":
        out += "\\b";
        break;
      case "\t":
        out += "\\t";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\f":
        out += "\\f";
        break;
      case "\r":
        out += "\\r";
        break;
      default:
        if (code <= 0x1f || code === 0x7f) {
          out += `\\u${code.toString(16).padStart(4, "0").toUpperCase()}`;
        } else {
          out += ch;
        }
    }
  }
  return `${out}"`;
}
