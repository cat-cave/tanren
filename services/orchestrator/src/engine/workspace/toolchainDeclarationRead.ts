// THE DECLARATION READ — one round-trip that brings a repository's toolchain declaration
// files back off the runner, and the framing that makes the result trustworthy.
//
// Split out of ./toolchainProvision.ts because it is the only part of that module whose
// input is REPOSITORY-CONTROLLED BYTES, and it has its own rule: nothing in this file
// believes anything about a line unless the line proves it came from a probe this
// invocation issued.

import { randomBytes } from "node:crypto";

import { quoteSshShellArg } from "../ssh/command.js";
import { MISE_CONFIG_REL_PATH } from "../ssh/miseActivate.js";
import {
  TOOLCHAIN_CONTENT_DECLARATION_PATHS,
  TOOLCHAIN_PRESENCE_DECLARATION_PATHS,
  type ToolchainDeclarationFile,
} from "./toolchainDeclarations.js";

// FRAMING IS BOUND TO THE INVOCATION, because the framed stream carries REPOSITORY BYTES.
// A fixed marker is not a delimiter when the thing being delimited can contain it: a repo
// that commits the literal line `===TANREN-TOOLCHAIN-DECLARATION:mise.toml===` inside its
// own `package.json` used to make the parser report a `mise.toml` that does not exist,
// which sets `deferToMiseConfig` and skips detection, provisioning AND enforcement
// entirely — the repo's content deciding that its own toolchain is not checked. The same
// trick could forge any other declaration file.
//
// TWO INDEPENDENT CONDITIONS now have to hold for a line to be read as a frame, and repo
// content can satisfy neither: it must carry the NONCE this invocation generated (which is
// not in the repository, because it did not exist when the repository was written), and its
// path must be one this invocation actually PROBED. `head -c` bytes are never scanned for
// anything else, so nothing else in a manifest can steer detection.
const DECLARATION_FRAME = "===TANREN-TOOLCHAIN-DECLARATION:";

// Emitted after a content file whose real size exceeds the read bound. Without it a
// truncated manifest is indistinguishable from a malformed one — see `truncated` on
// {@link ToolchainDeclarationFile} for why that distinction changes what gets provisioned.
const TRUNCATION_FRAME = "===TANREN-TOOLCHAIN-TRUNCATED:";

// Bounded per-file read. Root manifests are small; the bound exists so a pathological
// file can never flood the substrate, not as a policy on file size.
const DECLARATION_READ_BYTES = 65_536;

/** Every path this module probes. A frame naming anything else is repository content
 * imitating a frame, and is dropped. */
const PROBED_DECLARATION_PATHS: ReadonlySet<string> = new Set([
  MISE_CONFIG_REL_PATH,
  ...TOOLCHAIN_PRESENCE_DECLARATION_PATHS,
  ...TOOLCHAIN_CONTENT_DECLARATION_PATHS,
]);

/** A fresh, unguessable frame token for ONE declaration read. Not a secret and not
 * authentication — it exists so that bytes written before this run cannot forge a frame. */
export function newDeclarationNonce(): string {
  return randomBytes(12).toString("hex");
}

/**
 * One round-trip that emits every toolchain declaration file the workspace ships.
 * Content paths are emitted with their bytes; presence paths (lockfiles, which name a
 * tool but no version) are emitted as an empty frame, so a large or binary lockfile is
 * never piped back. A repo `mise.toml` is probed too because its presence short-
 * circuits detection entirely.
 */
export function toolchainDeclarationReadCommand(nonce: string): string {
  const marker = (prefix: string, path: string): string =>
    `printf '%s%s:%s===\\n' ${quoteSshShellArg(prefix)} ${quoteSshShellArg(nonce)} ${quoteSshShellArg(path)}`;
  const parts: string[] = [];
  for (const path of [MISE_CONFIG_REL_PATH, ...TOOLCHAIN_PRESENCE_DECLARATION_PATHS]) {
    parts.push(`if [ -f ${quoteSshShellArg(path)} ]; then ${marker(DECLARATION_FRAME, path)}; fi`);
  }
  for (const path of TOOLCHAIN_CONTENT_DECLARATION_PATHS) {
    const q = quoteSshShellArg(path);
    parts.push(
      `if [ -f ${q} ]; then ${marker(DECLARATION_FRAME, path)}; ` +
        `head -c ${String(DECLARATION_READ_BYTES)} ${q}; printf '\\n'; ` +
        // The bound can cut a manifest mid-token. Say so, rather than letting the parse
        // failure downstream be read as "this repository's manifest is malformed".
        `if [ "$(wc -c < ${q})" -gt ${String(DECLARATION_READ_BYTES)} ]; then ` +
        `${marker(TRUNCATION_FRAME, path)}; fi; fi`,
    );
  }
  return parts.join("; ");
}

/**
 * Parse {@link toolchainDeclarationReadCommand}'s stdout back into files. Pure.
 *
 * A line is a frame only if it carries THIS invocation's `nonce` AND names a path this
 * module probes; anything else is repository content that happens to look like one, and is
 * treated as file bytes. See the note on {@link DECLARATION_FRAME}.
 */
export function parseToolchainDeclarationOutput(stdout: string, nonce: string): ToolchainDeclarationFile[] {
  const files: ToolchainDeclarationFile[] = [];
  let current: { path: string; lines: string[]; truncated: boolean } | undefined;
  const flush = (): void => {
    if (current !== undefined) {
      files.push({ path: current.path, contents: current.lines.join("\n"), truncated: current.truncated });
    }
  };
  // `<prefix><nonce>:<path>===` — the path is whatever sits between the nonce and the
  // trailing `===`, and it is accepted only if it is one we probed.
  const framedPath = (line: string, prefix: string): string | undefined => {
    const opening = `${prefix}${nonce}:`;
    if (!line.startsWith(opening) || !line.endsWith("===") || line.length < opening.length + 3) return undefined;
    const path = line.slice(opening.length, line.length - 3);
    return PROBED_DECLARATION_PATHS.has(path) ? path : undefined;
  };
  for (const line of stdout.split("\n")) {
    const declared = framedPath(line, DECLARATION_FRAME);
    if (declared !== undefined) {
      flush();
      current = { path: declared, lines: [], truncated: false };
      continue;
    }
    const truncated = framedPath(line, TRUNCATION_FRAME);
    if (truncated !== undefined && current?.path === truncated) {
      current.truncated = true;
      continue;
    }
    current?.lines.push(line);
  }
  flush();
  return files;
}
