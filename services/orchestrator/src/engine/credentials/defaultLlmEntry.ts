import type { z } from "zod";
import { RoutingChainEntry } from "../config/shared.js";
import { credentialTypeForRef } from "./credentialType.js";
import { harnessAcceptsCredentialType, harnessCanBeDefault } from "../providers/harnessCapability.js";

// The DEFAULT LLM routing entry: a RoutingChainEntry constrained so it is
// actually runnable as the run-wide default. A per-role routing entry may name a
// writer-only harness (aider/opencode) or any compatible credential; a DEFAULT
// must be stricter because it heads EVERY empty role chain (plan/write/check/
// audit), so it must:
//   1. name a FULL-ROLE harness (harnessCanBeDefault — codex/claude today), and
//   2. name an authRef whose inferred credential-type that harness can consume
//      (harnessAcceptsCredentialType).
//
// This validation runs at PARSE time, so EVERY write path is gated — the connect
// route AND a generic org/project config PATCH both parse through here. The
// connect route's explicit pre-check is a nicer early error; THIS is the actual
// enforcement chokepoint (a config PATCH cannot persist an invalid default and
// have `resolveCredentialsForRun` later trust it).
export const DefaultLlmEntry = RoutingChainEntry.superRefine((entry, ctx) => {
  if (!harnessCanBeDefault(entry.cli)) {
    ctx.addIssue({
      code: "custom",
      message: `default LLM cli ${JSON.stringify(entry.cli)} is not a full-role harness (a default must serve every role)`,
      path: ["cli"],
    });
    return;
  }
  const credentialType = credentialTypeForRef(entry.authRef);
  if (credentialType === null) {
    ctx.addIssue({
      code: "custom",
      message: `default LLM authRef ${JSON.stringify(entry.authRef)} is not a recognized LLM credential`,
      path: ["authRef"],
    });
    return;
  }
  if (!harnessAcceptsCredentialType(entry.cli, credentialType)) {
    ctx.addIssue({
      code: "custom",
      message: `default LLM cli ${JSON.stringify(entry.cli)} cannot consume a ${credentialType} credential`,
      path: ["authRef"],
    });
  }
});
export type DefaultLlmEntry = z.infer<typeof DefaultLlmEntry>;
