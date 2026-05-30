# Hi-fi Vision Changes — SUPERSEDED (2026-05-29)

> **This document is superseded.** Its former "open vision changes" (drop Wafer
> from routing/vault, per-repo merge-integration CTAs, brownfield
> `.tanren/config.yaml` → `.tanren/PROJECT.md` one-time snapshot, settings
> audit-gate-conditional caption + subtitle) have **all been applied to the
> hi-fi** (see `tanren-hi-fidelity/chats/chat3.md` and the current
> `view-settings.jsx` / `view-onboard-existing.jsx` / `view-review.jsx`). There
> are no open items here.

The single living source for hi-fi ↔ implementation divergence is now the audit:

- **[`phase-3-hifi-gaps.md`](./phase-3-hifi-gaps.md)** — a dated, evidence-grounded
  audit with two sets: **Set 1** (hi-fi behind the implementation → edits the user
  makes to the hi-fi) and **Set 2** (implementation behind the hi-fi → build work).

## Notes on phasing

The hi-fi (`tanren-hi-fidelity` bundle) is the **phase-agnostic long-term product
vision** — per the chat4 design session it is deliberately _not_ tagged to any
v0/phase. Phasing — which subsets of the hi-fi ship when — is recorded in
`ROADMAP.md`, not by editing the hi-fi.
