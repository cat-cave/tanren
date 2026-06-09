import type { z } from "zod";
import { RoutingChainEntry } from "../config/shared.js";
import { isValidCredentialRefFormat } from "./codexAuth.js";
import { credentialTypeForRef, providerSlugForRef } from "./credentialType.js";
import {
  harnessAcceptsApiKeyProvider,
  harnessAcceptsCredentialType,
  harnessCanBeDefault,
} from "../providers/harnessCapability.js";

// The DEFAULT LLM routing entry: a RoutingChainEntry constrained so it is
// actually runnable as the run-wide default. A per-role routing entry may name a
// writer-only harness (aider/opencode) or any compatible credential; a DEFAULT
// must be stricter because it heads EVERY empty role chain (plan/write/check/
// audit), so it must:
//   1. name a FULL-ROLE harness (harnessCanBeDefault — codex/claude today), and
//   2. name an authRef whose inferred credential-type that harness can consume
//      (harnessAcceptsCredentialType) — and, for a raw `api_key`, whose PROVIDER
//      SLUG that harness can actually deliver (harnessAcceptsApiKeyProvider).
//
// The slug gate is load-bearing: a bare `api_key` accept is too coarse. codex
// delivers a raw key only as OpenRouter/native-OpenAI and claude only as native
// Anthropic, so codex+`credential/anthropic/` and claude+`credential/openrouter/`
// would pass the coarse check yet fail (or mis-authenticate) at run time. Gating
// on the slug here keeps the schema honest.
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
  // Gate the authRef against the SAME grammar the materializer enforces
  // (`validateCredentialRef`). The base `RoutingChainEntry` only requires a
  // non-empty string, and the slug/credential-type checks below only inspect the
  // PREFIX — so without this, a `credential/codex/…` ref that is well-prefixed but
  // malformed (a doubled-slash, an empty trailing segment, an illegal char) would
  // store fine and then crash the RUN deep in the codex materializer with the
  // format error. That is exactly the apex v29 BYOK-Codex halt: the ref-grammar
  // authority lived only at materialization, not at this config-write chokepoint.
  // Failing LOUD here (where the value is set) instead of mid-run keeps every
  // stored default a ref the materializer will accept; it applies to managed refs
  // too (they satisfy the grammar), so managed mode is unaffected.
  if (!isValidCredentialRefFormat(entry.authRef)) {
    ctx.addIssue({
      code: "custom",
      message: `default LLM authRef ${JSON.stringify(entry.authRef)} has an invalid credential ref format (must be credential/<slug>/<scope>/<owner>/<name>: single-slash-joined alnum/._- segments, no empty segment)`,
      path: ["authRef"],
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
    return;
  }
  // For a raw api_key, the credential-type accept is necessary but not sufficient:
  // the harness must be able to deliver THIS provider's key.
  if (credentialType === "api_key") {
    const slug = providerSlugForRef(entry.authRef);
    if (slug === null || !harnessAcceptsApiKeyProvider(entry.cli, slug)) {
      ctx.addIssue({
        code: "custom",
        message: `default LLM cli ${JSON.stringify(entry.cli)} cannot deliver a ${JSON.stringify(slug)} api_key (it delivers a raw key only for specific providers)`,
        path: ["authRef"],
      });
    }
  }
});
export type DefaultLlmEntry = z.infer<typeof DefaultLlmEntry>;
