# Audits

This directory holds point-in-time audit notes. The durable value of a past
audit is realized by **converting each finding into a mechanical check** rather
than leaving it as prose — once a risk is a gate, the audit note is history.

Most prior-risk categories are now enforced mechanically (see
[`docs/contracts/architecture-checks.md`](../contracts/architecture-checks.md)
for the full list), among them:

- schema drift (Drizzle generation + the drift gate),
- event writes restricted to `eventStore.ts` (`single-event-writer`),
- accepted cost sources enforced (`no-unknown-cost-source`),
- host process + Docker workload execution guarded,
- the production stub-ban (`no-production-stubs`) and the real-resource `just e2e` gate (`e2e-no-mock-imports`),
- raw row casts barred from workflow code (`no-raw-row-casts-in-workflow`),
- source / config / docs line limits, complexity, and param-count ratchets.

When a new audit runs, lift each finding into an executable check or a behavior
test; do not add broad audit fixtures disconnected from a gate. There are no
open audit notes in this directory at present.
