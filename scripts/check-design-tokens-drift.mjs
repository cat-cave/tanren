#!/usr/bin/env node
/**
 * drift guard: the dashboard's copy of the design tokens CSS must
 * stay byte-identical to the source of truth in `docs/design/tokens/`.
 *
 * Tokens live in `docs/design/tokens/colors_and_type.css`. The dashboard
 * server-renders that CSS verbatim at `services/dashboard/src/design/tokens.css`.
 * Future services that consume tokens may add their own dashboard-style copy;
 * each copy must be registered in `TOKEN_COPIES` below.
 *
 * Wired into `just fast-check` via `corepack pnpm run check:design-tokens-drift`.
 */

import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { exit } from "node:process";

const SOURCE_OF_TRUTH = "docs/design/tokens/colors_and_type.css";
const TOKEN_COPIES = ["services/dashboard/src/design/tokens.css"];

export async function checkDesignTokensDrift({ root = process.cwd() } = {}) {
  const sourcePath = resolve(root, SOURCE_OF_TRUTH);
  const source = await readFile(sourcePath, "utf8");
  const diagnostics = [];
  for (const copy of TOKEN_COPIES) {
    const copyPath = resolve(root, copy);
    let copyText;
    try {
      copyText = await readFile(copyPath, "utf8");
    } catch (error) {
      diagnostics.push({
        copy,
        message: `unable to read token copy: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    if (copyText !== source) {
      diagnostics.push({
        copy,
        message: `drift detected against ${SOURCE_OF_TRUTH} — regenerate by copying the source over the dashboard copy`,
      });
    }
  }
  return diagnostics;
}

function formatDiagnostics(diagnostics, root) {
  return diagnostics.map((item) => `${relative(root, resolve(root, item.copy))}: ${item.message}`).join("\n");
}

const invokedDirectly = process.argv[1] && import.meta.filename === resolve(process.argv[1]);
if (invokedDirectly) {
  const diagnostics = await checkDesignTokensDrift();
  if (diagnostics.length > 0) {
    console.error(formatDiagnostics(diagnostics, process.cwd()));
    exit(1);
  }
  console.log("design tokens drift check passed");
}
