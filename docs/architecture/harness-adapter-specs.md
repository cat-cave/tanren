# Harness adapter specs — agy / pi / reasonix

This doc captures **researched CLI invocation specs** for three coding-agent
harnesses we want to slot behind the harness protocol
([`harness-protocol.md`](./harness-protocol.md)): **agy** (Google Antigravity
CLI), **pi** (the minimal coding-agent harness), and **reasonix** (the
DeepSeek-native coding agent). Each would become one entry in the
[`HARNESS_CAPABILITIES`](../../services/orchestrator/src/engine/providers/harnessCapability.ts)
table plus an adapter.

The **gating capability** is structured output (§2 of the protocol): a harness
that can emit schema-constrained JSON for an `answer` task is **Answerer-eligible**
(plan / check / audit / discovery / forge) _and_ Writer-eligible; a harness
without it is **writer-only**. The whole point of this research is to decide, per
tool, which capability class it lands in and whether its spec is concrete enough
to build against.

> **Research note (sources change).** All three CLIs are young and moving fast
> (agy shipped May 2026; pi and reasonix are under active 0.x development). Specs
> below were gathered from web sources in **May 2026** and cite primary sources
> where possible. Confidence is marked per claim/tool. Where a spec could not be
> confidently established, this doc says so rather than guessing — that is itself
> a useful result, because we do **not** want to wire an adapter against an
> invented invocation.

---

## Summary table

| Tool         | Install                                                               | Non-interactive invocation                                               | Auth                                                                         | Structured JSON output                                                                    | Capability class                 | Confidence | Ready to build?                           |
| ------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------- | ---------- | ----------------------------------------- |
| **agy**      | `curl …/cli/install.sh \| bash` (Google)                              | `agy -p "<prompt>"` (print mode)                                         | Google OAuth sign-in (default) **or** `ANTIGRAVITY_API_KEY`                  | **No** working JSON channel; `-p` stdout broken in non-TTY                                | writer-only (today)              | medium     | **No** — blocked by headless stdout bug   |
| **pi**       | `npm i -g @earendil-works/pi-coding-agent` / `curl pi.dev/install.sh` | `pi -p "<prompt>"`, stdin pipe, `--mode json`                            | Per-provider env keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) or `/login` | **No** schema-constrained answer (declined upstream); has JSON **event** stream           | writer-only                      | high       | **Yes** (writer-only)                     |
| **reasonix** | `npm i -g reasonix` (alias `dsnix`)                                   | `reasonix run "<task>"` (headless, CI-friendly); `reasonix acp` (NDJSON) | First-run wizard → `~/.reasonix/config.json`, **or** `DEEPSEEK_API_KEY` env  | **Partial** — NDJSON ACP protocol + JSONL transcripts; no doc'd schema-constrained answer | writer-only (answer unconfirmed) | medium     | **Yes** (writer-only); answer needs spike |

Net: **none of the three is confidently Answerer-eligible today.** All three are
plausible **writer-only** harnesses; pi is the cleanest to wire, reasonix is
close behind, and agy is blocked on a real headless bug.

---

## agy — Google Antigravity CLI

The terminal coding agent Google shipped to **replace the deprecated Gemini CLI**
(Gemini CLI stops serving Pro/Ultra/free requests on **2026-06-18**). Rewritten
in Go; ships a sub-agent orchestrator; exposes ~8 models across Gemini 3.x,
Claude Sonnet/Opus 4.6, and GPT-OSS 120B inside one terminal. Binary is `agy`.

### Install + invocation

- **Install** (`high`): `curl -fsSL https://antigravity.google/cli/install.sh | bash`
  (Windows: `irm https://antigravity.google/cli/install.ps1 | iex`). Binary
  installs to `~/.local/bin/agy` (Unix) / `%LOCALAPPDATA%\Antigravity\` (Windows).
- **Non-interactive** (`medium`): `agy -p "<prompt>"` — `-p` is the short alias
  for `--print`, "run a single prompt non-interactively and print the response."
  `agy` with no args launches the interactive TUI.
- **Working directory** (`low`): no documented `--cwd`/workdir flag found; appears
  to operate on the current directory. **Adapter would need to `cd` into the
  workspace before invoking** (which fits our transport-is-out-of-scope stance).
- **Model selection** (`low`): `-m <model>` is reported in one hands-on guide
  (`agy -m my-custom-model -p "…"`); the in-TUI path is the `/model` slash
  command. Treat the `-m` flag as **unconfirmed**.
- **Prompt delivery** (`medium`): as the `-p` argument; piping to stdin is not
  confirmed for headless use.

### Auth model (`medium`)

Two modes: **(1)** Google OAuth — first run triggers a browser sign-in (SSH /
headless prints an auth URL + one-time code); tokens cached under
`~/.gemini/antigravity-cli/` (e.g. `credentials.enc`). **(2)** API key via
`export ANTIGRAVITY_API_KEY="…"`. Config lives at
`~/.gemini/antigravity-cli/settings.json`.

### Structured output (`medium`) — **NO usable channel today**

- There is **no working JSON output mode.** Community write-ups reference
  `--output-format json` / `--output-format stream-json`, but users hit
  `flags provided but not defined: -output-format` — **the flag is not actually
  implemented** in agy 1.0.x.
- Worse, **`agy -p` is broken in non-TTY contexts**: it authenticates, sends the
  prompt, gets a model response, then **never writes it to stdout** (exit 0, empty
  pipe). A community MCP bridge works around this by reading agy's internal
  transcript JSONL at
  `~/.gemini/antigravity-cli/brain/<conv-id>/.system_generated/logs/transcript.jsonl`
  and extracting the final `PLANNER_RESPONSE` entry — i.e. there **is** an internal
  JSONL transcript, but it is not a documented/stable output contract.

### `HARNESS_CAPABILITIES` entry (proposed)

```ts
{ cli: "agy", roles: ["write"], structuredOutput: false } // writer-only
```

No schema-constrained answer channel ⇒ writer-only at best. (The internal
transcript JSONL is _not_ a structured-output channel we'd build an Answerer on.)

### Ready to build? **NO (blocked).**

The headless `-p` stdout bug makes even a **writer-only** adapter non-viable
without scraping agy's private state files — a brittle integration we should not
take on. **Recommendation: wait** for a fixed `-p` (and ideally a real
`--output-format`/stream-json). Track the upstream "emit per-conversation ID so
headless callers can resume" issue and re-evaluate when headless stdout works.

### Sources

- Google Developers Blog — Gemini CLI → Antigravity CLI transition: <https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/>
- Official AGY docs (JS-rendered, not machine-extractable here): <https://antigravity.google/docs/cli-using>
- Hands-on guide (install, `-p`, `-m`, `ANTIGRAVITY_API_KEY`): <https://dev.to/arindam_1729/antigravity-cli-a-hands-on-guide-to-googles-terminal-coding-agent-5bc7>
- Install/migrate + auth/config paths: <https://pasqualepillitteri.it/en/news/3422/antigravity-cli-agy-install-migrate-gemini-cli>
- `-p` non-TTY stdout bug + transcript workaround + paths: <https://github.com/SinanTufekci/Claude-Code-Antigravity-CLI-MCP-Server>
- Headless `--print` resume issue: <https://github.com/google-antigravity/antigravity-cli/issues/7>

---

## pi — Pi Coding Agent

A deliberately minimal, "make-it-your-own" terminal coding harness
(`@earendil-works/pi-coding-agent`, repo `badlogic/pi-mono`). Runs in four modes:
interactive, print, RPC, and an embeddable SDK. Multi-provider.

### Install + invocation (`high`)

- **Install**: `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`
  or `curl -fsSL https://pi.dev/install.sh | sh`.
- **Non-interactive print mode**: `pi -p "<prompt>"` (one-shot, no session saved),
  or pipe stdin: `cat README.md | pi -p "Summarize this"`. Prompt can also be the
  trailing positional arg: `pi "<prompt>"`.
- **JSON event mode**: `pi --mode json "<prompt>"` — emits **all events as JSON
  lines** (one JSON object per line) on stdout. This is a telemetry/event stream,
  **not** a schema-constrained final answer (see structured-output note).
- **RPC mode**: `pi --mode rpc` — headless `\n`-delimited JSONL protocol on
  stdin/stdout for embedding (read JSON commands, write JSON events/responses).
- **Model selection**: `--provider <anthropic|openai|google>`, `--model <provider/id>`
  (e.g. `--model openai/gpt-4o`), optional thinking level `--model sonnet:high`.
- **Working directory** (`medium`): no explicit workdir flag documented; sessions
  are "organized by working directory" (i.e. derived from cwd) — adapter `cd`s in.
- **File/context**: `pi @file.ts "Review this"` includes a file; images supported.

### Auth model (`high`)

Per-provider environment variables — `ANTHROPIC_API_KEY=sk-ant-…`,
`OPENAI_API_KEY=…`, plus others in pi's `providers.md`; or OAuth via `pi` then
`/login`. This is the clean `authRef`-materialize-to-env shape our other adapters
already use.

### Structured output (`high`) — **NO schema-constrained answer**

This is the load-bearing finding, and it is a clean negative:

- pi has a JSON **event** stream (`--mode json`) and a JSONL **RPC** protocol —
  both machine-readable, but they carry _events_, not a JSON-schema-constrained
  _answer_.
- The feature request to add real structured output —
  [`badlogic/pi-mono#1086`](https://github.com/badlogic/pi-mono/issues/1086)
  "Add structured output (JSON schema) support" — was **closed (2026-01-30)**.
  Although GitHub marks it `completed`, the closing discussion shows the
  maintainer **declined** to add provider-level JSON-schema output ("still not
  entirely reliable … I do not want to do that in pi-ai") and instead suggested
  exposing an automation-specific _tool_ the agent calls to record JSON. So:
  **pi has no native schema-constrained answer channel**; "pi-ai only validates
  tool arguments, [there is] no supported path to enforce JSON schema output for
  assistant text."

So pi cannot serve the protocol's `answer` role as-is. (We _could_ one day reach
the Answerer role via the suggested "record-JSON tool" pattern, but that's a
custom extension, not a CLI flag we wire today.)

### `HARNESS_CAPABILITIES` entry (proposed)

```ts
{ cli: "pi", roles: ["write"], structuredOutput: false } // writer-only
```

Sits alongside opencode/aider in the writer-only class. The `--mode json` event
stream is exactly the kind of per-line JSON our existing writer adapters parse for
`telemetry` (token usage / usage-limit signals) per protocol §4.4.

### Ready to build? **YES — as a writer-only harness.**

Concrete, well-documented invocation (`pi -p`), clean env-var auth, and a JSON
event stream we can parse for telemetry. The only loose end before coding is
confirming pi's event-stream token-usage shape (so the adapter maps to the
disjoint `TokenUsage` buckets in §4.3) and its usage-limit phrase (for the
`window_exhausted` classification). Do **not** attempt to wire it as an Answerer.

### Sources

- pi usage docs (modes, flags, model selection): <https://pi.dev/docs/latest/usage>
- pi coding-agent README: <https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md>
- npm package: <https://www.npmjs.com/package/@mariozechner/pi-coding-agent>
- Structured-output issue (closed; declined in discussion): <https://github.com/badlogic/pi-mono/issues/1086>
- Author write-up (design intent): <https://mariozechner.at/posts/2025-11-30-pi-coding-agent/>

---

## reasonix — DeepSeek-native coding agent

Open-source terminal coding agent built **around DeepSeek** (prefix-cache-first
loop, flash-first cost control, automatic tool-call repair). Launched ~2026-05-25.
DeepSeek-only on purpose ("coupling to one backend is the feature"). npm package
`reasonix` with short alias `dsnix`.

### Install + invocation

- **Install** (`high`): `npm install -g reasonix` (or `npm install -g dsnix`;
  `npx reasonix code` / `npx dsnix@latest code` without global install). Requires
  Node 20.10+.
- **Subcommands** (`high`): bare `reasonix` (= `reasonix code` in cwd);
  `reasonix code [dir]` (file-editing agent, SEARCH/REPLACE review);
  `reasonix chat` (tools-off chat, no fs/shell); **`reasonix run "<task>"`**
  ("Headless run — read prompt, execute, exit (CI-friendly)", streams to stdout);
  `reasonix setup` (interactive config); plus `sessions`, `replay`, `diff`,
  `events`, `stats`, `doctor`, `commit`, `mcp`, `index`, `acp`, `version`,
  `update`.
- **Headless `run`** (`medium`): `reasonix run "<task>"` — task is a quoted
  **positional argument**; streams to stdout. Whether stdin delivery is supported
  is **unconfirmed**, and the `run` **stdout format** (plain text vs JSON) is
  **not documented** in the CLI reference.
- **`reasonix acp`** (`high`): a **headless ACP (Agent Client Protocol)
  entrypoint** with **NDJSON framing** — `initialize` / `session/new` /
  `session/prompt` round-trip (CHANGELOG 0.41.0). This is the most promising
  machine-integration surface (structured, line-framed JSON over stdio).
- **`--transcript <path>`** (`high`): writes JSONL receipts with `usage` / `cost`
  / `prefixHash` (CHANGELOG 0.41.0) — a clean source for protocol §4.3 token usage.
- **Working directory** (`medium`): `reasonix code [dir]` takes an initial dir;
  `/cwd <path>` (alias `/sandbox`) switches root mid-session in the TUI.
- **Model selection** (`high`): `--preset <auto|flash|pro>` (model bundle);
  in-TUI `/model <id>`, `/pro` (next turn), `/preset max` (session). Default is
  DeepSeek-V4-Flash; pro is DeepSeek-V4-Pro.
- **Other run-relevant flags** (`high`): `--no-session`, `--session <name>`,
  `--continue`, `--new`, `--budget <usd>`, `--mcp <spec>`, `--no-config`,
  `--no-dashboard`.

### Auth model (`high`)

DeepSeek API key via **first-run wizard** persisted to `~/.reasonix/config.json`
(no env var required), **or** the **`DEEPSEEK_API_KEY`** environment variable,
with **`DEEPSEEK_API_BASE_URL`** accepted as a base-url override alias (CHANGELOG
0.48.0). For our adapter the env-var path is the one to materialize from `authRef`.

### Structured output (`medium`) — **partial; answer-role unconfirmed**

- **Yes, machine-readable surfaces exist:** the `acp` entrypoint's **NDJSON**
  protocol, `--transcript` **JSONL** receipts, and a `doctor --json` flag
  ("structured machine-readable output … scriptable / pipeable for CI",
  CHANGELOG 0.46.0). Hooks also exchange JSON envelopes on stdin/stdout.
- **But:** none of these is documented as a **JSON-schema-constrained final
  answer**. ACP is an _event/session_ protocol (like pi's RPC), and transcripts
  are _receipts_. There is **no documented flag to constrain `reasonix run`'s
  output to a caller-supplied JSON schema**. So Answerer-eligibility is
  **unconfirmed** — it hinges on whether ACP `session/prompt` (or a `run` flag)
  can be driven to emit schema-validated JSON, which the public docs don't settle.

### `HARNESS_CAPABILITIES` entry (proposed)

```ts
{ cli: "reasonix", roles: ["write"], structuredOutput: false } // writer-only (today)
```

Start writer-only. If a spike shows ACP `session/prompt` can return
schema-constrained JSON (or a `run --json --schema`-style flag lands upstream),
**promote** to `roles: ["write","answer"], structuredOutput: true`.

### Ready to build? **YES for writer-only; answer-role needs a spike.**

`reasonix run "<task>"` + `DEEPSEEK_API_KEY` + `--transcript` JSONL (for token
usage) is enough to wire a **writer-only** adapter with good telemetry. Two loose
ends before coding: (1) confirm `run`'s stdout format and how we recover the diff
(reasonix is git-diff-native, so the adapter likely captures baseline + `git diff`
as with our other writers); (2) **separately spike** whether the ACP NDJSON path
yields schema-constrained answers before claiming Answerer-eligibility.

### Sources

- DeepSeek-native launch coverage: <https://winbuzzer.com/2026/05/25/reasonix-launches-deepseek-native-terminal-coding-agent-xcxwbn/>
- CLI reference (`run`, subcommands, `--preset`, flags): <https://github.com/esengine/DeepSeek-Reasonix/blob/main/docs/CLI-REFERENCE.md>
- CHANGELOG (`acp` NDJSON, `--transcript` JSONL, `doctor --json`, `DEEPSEEK_API_KEY`/`DEEPSEEK_API_BASE_URL`): <https://github.com/esengine/DeepSeek-Reasonix/blob/main/CHANGELOG.md>
- Official site (install, models, first-run wizard auth): <https://esengine.github.io/DeepSeek-Reasonix/>
- DeepSeek docs — Integrate with Reasonix: <https://api-docs.deepseek.com/quick_start/agent_integrations/reasonix>
- npm package: <https://www.npmjs.com/package/reasonix>

---

## Overall verdict

| Tool         | Capability class (today)         | Build now?            | Blocker / next step                                                                 |
| ------------ | -------------------------------- | --------------------- | ----------------------------------------------------------------------------------- |
| **agy**      | writer-only (at best)            | **No**                | Headless `-p` writes nothing to stdout; no real JSON mode. Wait for fix.            |
| **pi**       | writer-only                      | **Yes**               | Map `--mode json` events → `TokenUsage`/usage-limit; do not wire as Answerer.       |
| **reasonix** | writer-only (answer unconfirmed) | **Yes** (writer-only) | Wire `run` + `DEEPSEEK_API_KEY` + `--transcript`; spike ACP NDJSON for answer-role. |

**Bottom line:** the protocol's earlier framing of agy/pi/reasonix as "future
members" of the capability classes holds, but with a correction — **on current
public specs none of the three is confidently Answerer-eligible.** pi and reasonix
are buildable **writer-only** harnesses now (pi is the cleanest); agy is blocked
on a genuine headless bug and should not be wired until `-p` emits to stdout.
Answerer-eligibility for any of them would need an explicit upstream
structured-output capability we have not been able to confirm.
