# Central Review Authority foundation

This package is workstation operations tooling, not part of the Tanren engine. It currently implements the CRA-01 through CRA-04 foundation: bounded `poll-once`, typed configuration and GitHub App identity verification, lock-protected durable state, read-only GitHub discovery, verified detached worktrees, and disposable execution of PR-controlled commands.

Copy `config.example.json` to `${XDG_CONFIG_HOME:-$HOME/.config}/tanren-cra/config.json`, replace every operator-specific value, and keep the GitHub App PEM outside the repository with mode `0600`. Then run:

```sh
corepack pnpm --filter @tanren/cra poll-once
```

`TANREN_CRA_CONFIG` may name a different absolute config path. Relative repository, key, and worktree paths are resolved relative to the config file, but the key, state root, and worktree root are rejected if they resolve inside the repository. Mutable state is always derived from XDG state as `${XDG_STATE_HOME:-$HOME/.local/state}/tanren-cra/<owner>-<repo>`; no state-directory override exists.

The installation token is minted for each poll from the owner-only App key. CRA verifies `viewer.login` against `github.expectedLogin` before discovery. Discovery invokes only `gh api graphql` queries and cannot issue repository mutations.

PR records use sibling temporary files, file and directory synchronization, and atomic rename while the singleton lease is held. A torn JSONL tail is truncated on recovery; corruption before the final record is rejected. Audit artifacts add a rubric-version directory beneath the design's documented PR/head hierarchy:

```text
audits/<pr>/<head-sha>/<rubric-version>/report.json
```

That extra segment resolves the design's otherwise ambiguous requirement that artifacts be immutable per PR/head/rubric tuple while allowing a rubric change to re-audit an unchanged head.

The isolated runner uses a configured local container image. It mounts the verified worktree read-only at `/input`, copies it to an ephemeral `/work` tmpfs, disables networking, drops capabilities, enables `no-new-privileges`, applies CPU/memory/PID and wall-clock limits, exposes no host home, state directory, credentials, or container socket, and forcibly removes the container after every result.

## Deep adversarial audit + official review (CRA-05, CRA-06)

The `audit` config block names the cross-model audit worker CLI (`command`, `args`, `modelFamily`) — a different model family from any contributor and from the supervisor, like the grok gate used to build this repo. For each selected head the adapter serializes the audit context (linked issue + acceptance + required negative control, PR body, complete diff, deletion statistics, standards, and CI check evidence) to the worker's stdin, strips the GitHub installation token from the worker's environment, and requires strict JSON on stdout. The report is validated against a strict schema; a malformed, truncated, or head-mismatched report is a fail-closed audit failure, never an empty finding set.

**Trust boundary — the crux.** The audit worker AUTHORS its report, so every field it controls is spoofable. The report is therefore **advisory judgment only: it can ADD P0-P3 findings, but it can never confirm, clear, or suppress a gate.** Every gate-critical condition is computed by the supervisor from GROUND TRUTH, never from a worker-controlled field:

- **Deletions** — parsed from the real unified diff. The worker's `deletionAccounting` (including any `justified: true` or a bogus `deletedLines`) is **ignored for the gate**. A net test-line regression blocks; net live-code deletion at or above `audit.deletionGate.liveLineThreshold` blocks. The worker may EXPLAIN a deletion in a finding, but it cannot self-clear the supervisor's computed gate (the mq-16 defense).
- **CI checks** — the real required-check states from GitHub (CRA-03 discovery). Any non-passing required check blocks. The worker's `unresolvedChecks` field is **not consulted** — an empty array cannot mean "all clear."
- **Negative controls** — a worker-supplied command can NEVER confirm a fail-closed claim; an arbitrary command (even an `env false` wrapper) cannot be tied to the PR's boundary. The supervisor runs exactly ONE **trusted, config-sourced** verification command (`audit.verificationCommand`) in the CRA-04 sandbox against the PR head. A run that fails is a P1 block; a run that could not happen is P0 (unproven acceptance). The worker may only self-incriminate: a mandatory control it itself reports as not-rejected is an admitted fail-open (P0).
- **Acceptance** — a satisfied claim must cite a file the supervisor can locate in the worktree tree; keyword prose (`"just looks good"`) or a citation to a non-existent file is an unmet acceptance gap (P0). An unsatisfied trace is P0.
- **Independence** — computed from PR provenance; an unconfirmable cross-model check on an agent-authored PR is P0.

Any P0/P1 (advisory or supervisor-computed) yields `REQUEST_CHANGES`; only P2/P3 (or none) yields `APPROVE`.

Exactly one official review is posted for the audited head SHA (`POST /repos/<owner>/<repo>/pulls/<n>/reviews` with `commit_id` bound to the audited head, inline comments for locatable findings, others summarized with evidence). Every review body carries a stable `<!-- tanren-cra:v1 pr=<n> head=<sha> rubric=<version> -->` marker; the poster scans existing bot reviews for a matching marker first, so a re-poll of the same head never posts a duplicate. The disposition is persisted in the foundation state store.
