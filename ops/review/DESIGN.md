# OCR review layer — design & interface contract

Engine-external advisory PR reviewer (transitional; MergeAuthority absorbs it later).
OCR (`alibaba/open-code-review`) is the stateless diff engine; **everything stateful,
secure, and cost-bounded lives in this wrapper.** No fork — all hardening is wrapper-level.

## Pipeline (two-tier CI + review + native merge queue)

```
mergeable? (CONFLICT→block; behind-main→queue handles it, do NOT block)
  → ci-light (fast: typecheck/lint/format/unit/arch-checks) gates
  → REVIEW  (this layer: luna[+hy3] + rules, PR-aware/incremental)
       open P0/P1 ⇒ review/verdict=FAIL, blocked from queue
       only P2/P3 ⇒ verdict=PASS, STASH followups on the PR
  → auto-enter merge queue
  → ci-heavy (full ci+smoke+RLS on merge_group, batched/rebased) → native bisect on fail
  → MERGE
  → post-merge hook: file the STASHED P2/P3 as issues, referencing the MERGED sha
```

## SECURITY (issue #110 — mandatory, non-negotiable)

OCR reads `.opencodereview/rule.json` **from the checked-out PR head** and has a
git-option-injection RCE (`--commit '-O./pwn.sh'`). Therefore:

1. **Split jobs.** `ocr-review-untrusted.yml` runs on `pull_request` (fork-safe): **no
   secrets**, checks out PR head **read-only**, runs OCR to produce a JSON artifact ONLY.
   `ocr-review-trusted.yml` runs on `workflow_run` (completed): holds secrets, downloads
   the artifact, posts reviews + sets the verdict. Comments/secrets NEVER touch PR-head code.
2. **Rules from the trusted base, never PR head.** Pass `--rule <abs path to
ops/review/tanren-ocr-rules.json checked out from the BASE ref>`. Delete any PR-head
   `.opencodereview/` before invoking OCR.
3. **Sanitize refs.** Never interpolate a PR-supplied branch/ref/sha into an OCR arg
   without validating it against `^[0-9a-f]{7,40}$` (sha) / a strict branch grammar.
   Reject a leading `-`.
4. **rule-change guard.** If a PR modifies `ops/review/**` or any `.opencodereview/**` or
   `.github/workflows/ocr-*`, the untrusted job must **flag it** (output `rule_change=true`);
   the trusted job posts a P0 "reviewer-config change — maintainer review required" and
   sets verdict=FAIL. A PR cannot weaken its own reviewer.
5. Ephemeral runner; do not set git `safe.directory '*'`.
6. **Fail closed on an incomplete review (do NOT regress).** Zero findings is
   "clean" ONLY when OCR actually ran and certified. A crash, a **missing LLM key
   (fork `pull_request` runs get no secret)**, or a partial stream also yields
   zero findings — treating that as a pass green-lights unreviewed code. The
   untrusted lane records `review_complete` (true iff OCR exits 0 and emits valid
   JSON); `verdict.mjs` fails `review/verdict` closed and `post-review.mjs`
   requests changes ("review did not complete") whenever it is not certified. A
   fork PR is therefore never auto-approved — it must be reviewed via the
   authorized `/review` path (item 7).
7. **Fork review via an authorized `/review` command.** A fork `pull_request` run
   gets no LLM key, so it fails closed (item 6). To actually review a fork,
   `ocr-review-untrusted.yml` also triggers on `issue_comment`: a `/review`
   comment runs OCR **with the key** against the fork code — the SAME blast radius
   as the same-repo untrusted lane (LLM key only, NO write token → worst case is
   capped LLM spend). The job-level `if:` authorizes it (so an unauthorized
   comment never checks out fork code) for a trusted human
   (OWNER/MEMBER/COLLABORATOR) **or** the `trevor-workstation[bot]` agent identity
   (agents auditing agents). SHAs are resolved from the PR API (never the comment
   text), sanitized, and the fork head is checked out read-only via the advertised
   `refs/pull/<n>/head`. The trusted `workflow_run` lane posts as usual; its
   head-SHA equality check is skipped for issue_comment (which runs on the default
   branch, so `workflow_run.head_sha` is the base head, not the PR head).

## COST GATE (issue #409 — OCR `review` has NO internal budget)

The untrusted job runs `scripts/preflight.mjs` FIRST:

- Reject/oversize-flag if changed **non-excluded** files > `MAX_FILES` (default 60) or
  net diff lines > `MAX_DIFF_LINES` (default 8000) → emit `oversized=true`, review only the
  top-priority paths (engine/db/routes) and note the cap in the summary (never silently drop).
- Apply the **ignore-glob** (extend OCR `default_exclude_patterns.json` + our list):
  `**/*.snap`, `db/migrations/meta/**`, `**/*.generated.*`, `**/dist/**`, lockfiles,
  `contracts/json/**`, `**/__snapshots__/**`.
- Enforce a **global deadline** (`REVIEW_DEADLINE_SEC`, default 1800); a timed-out OCR run
  is fully billable — always record tokens from partial JSON.
- Run OCR from the **git root** (issue #287); `--background-file` uses an **absolute path**
  (issue #324).

## Canonical finding record (the shape every script passes around)

OCR emits `comments[]` with `{path,start_line,end_line,content,category,severity}`
(severity ∈ critical/high/medium/low/info — issue #16). We normalize to:

```jsonc
{
  "path": "services/.../x.ts",
  "start_line": 120,
  "end_line": 128, // 0/0 ⇒ unlocatable
  "severity_ocr": "critical", // OCR's raw severity
  "priority": "P0", // OUR ladder, derived (see mapping)
  "category": "security",
  "title": "…",
  "body": "…", // parsed from content
  "fingerprint": "sha1(norm(path)+symbol+norm(claim))", // semantic key (issue #369)
  "grounded": true, // line ∈ changed-hunk set (issue #6/#167)
  "state": "new|carried|addressed", // set by reconcile.mjs
}
```

Priority mapping: OCR `critical|high` → candidate **P0/P1** (gate-blocking); `medium` →
**P2**; `low|info` → **P3**. The rule prose already tells the model to reserve critical/high
for provable fail-open — trust the model's severity but **re-verify grounding** before gating.

## Sticky-marker state (lives in the PR — no external DB)

The sticky summary comment ends with one HTML-comment marker:

```
<!-- ocr-state v1 last_reviewed_sha=<sha> open=<fp,fp,…> dismissed=<fp,fp,…> followups=<fp,fp,…> -->
```

`reconcile.mjs` reads the prior marker, computes new state, rewrites it. `open`=unresolved
P0/P1; `dismissed`=fingerprints a maintainer resolved (never resurface — issue #59/#369);
`followups`=stashed P2/P3 to file post-merge.

## Script contracts (`ops/review/scripts/`, Node ESM, gh CLI + node:built-ins only)

- **preflight.mjs** — in: base+head sha, changed files. out: `{oversized, files_reviewed_globs, deadline}`; applies ignore-glob + size gate (#409).
- **assemble-context.mjs** — in: PR number. out: absolute-path `context.md` = prior OCR findings + human/other-bot comments + discussion + linked-issue acceptance/negative-control (for `--background-file`; #59/#324).
- **select-model.mjs** — in: preflight result + changed paths. out: `{models:[…], reason}`. Routing: default `openai/gpt-5.6-luna`; high-stakes paths (`engine/merge/**`, `db/migrations/**`, RLS/orgScope) MAY add a second model for cross-confirmation; docs/test-only → cheapest. (Config: `model-routing.json`.)
- **ground-findings.mjs** — in: OCR JSON + git diff hunks. out: findings with `grounded`; drop/relocate off-diff + wrong-file misattributed (#6/#167).
- **dedup.mjs** — in: findings + prior `open`/`dismissed` fingerprints. out: deduped findings (semantic fingerprint, not exact text — #369); drop anything in `dismissed`.
- **reconcile.mjs** — in: new findings + prior marker. out: findings tagged new/carried/addressed + the new marker string; addressed = prior open fp whose file/hunk changed and no longer raised (mind nondeterminism #247 — require the hunk to have changed, not just absence).
- **post-review.mjs** — in: reconciled findings. RECONCILES inline comments in place, keyed by finding fingerprint (hidden `<!-- ocr-finding:<fp> -->` marker): PATCH an existing bot comment, DELETE+re-POST when its line moved (the API can't move a comment's line), POST a new fp, DELETE any bot fp no longer raised (resolved). Submits a native review (REQUEST_CHANGES if open P0/P1 else APPROVE… see identity note) **only on a state change** vs the bot's last review — no inline `comments[]` ride along (managed separately), so re-review does not clog the conversation. **line 0/0 ⇒ file-level/summary fallback, never drop** (#80); **throttle + exponential backoff on 403 secondary-rate-limit, cap inline comments/run** (#158); updates sticky summary + marker.
- **verdict.mjs** — sets the `review/verdict` commit status (success iff open P0/P1 == 0), bound to the exact reviewed sha (#16).
- **file-followups.mjs** — post-merge only: reads the merged PR's `followups` fingerprints, files one claimable issue each referencing the merged sha + linking the PR; discard if PR was not merged.

## Not available in OCR OSS (design around)

Per-task model tiering (#322), `--provider` runtime flag (#458), settable prompt-cache key
(#229 — intra-review auto-caching still works), file bundling (#68 — cost is per-file).
The 180s `REVIEW_FILTER_TASK` inner timeout (#461) can't be overridden → slow models (hy3)
may need `--resume`; the retry-until-coverage harness handles it.
