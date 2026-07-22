## What + which issue

Closes #<issue>. <one-line summary of the general capability/fix.>

## Gate (must all be true before review)

- [ ] `just fast-check` green + `just ci` green (+ `just smoke` if RLS/integration touched)
- [ ] Branch up-to-date with `main`
- [ ] **Negative control** added/updated — the fail-open this blocks is proven (name the test)
- [ ] **Clean-replace**, not cosplay — superseded code deleted, no shims
- [ ] **No apex-shaping** — nothing names apex or hard-codes a fixture's specifics; the capability is general (any project/tenant uses it)
- [ ] Migrations/shared files (nav/screens.ts/main.ts/registries) flagged for merge sequencing if touched

## Proof

<the positive proof it works + the negative control result — real evidence, not a claim.>
