/**
 * Review-handoff island. Hydrates the server-rendered review chat:
 *   - clicking a behavior row toggles its you-verified state;
 *   - clicking a deferral action (handle / defer / dismiss) resolves it;
 *   - the readiness-gate pills + nudge turn recompute live from those states;
 *   - clicking a device tab re-widths the live preview iframe.
 *
 * No server round-trip for the checklist (it is operator-local verification);
 * `request changes` is a real form POST handled server-side. Sign-off CTAs stay
 * disabled in v0 per the spec (merge integration is a later surface).
 */

export function initReviewHandoff(): void {
  const root = document.querySelector<HTMLElement>('[data-island="review"]');
  if (root === null) return;

  const behaviorCount = Number(root.dataset["behaviorCount"] ?? "0");
  const deferralCount = Number(root.dataset["deferralCount"] ?? "0");
  const ciGreen = root.dataset["ciGreen"] === "1";

  const verified = new Set<string>();
  const resolved = new Map<string, string>();

  const recompute = (): void => {
    // verified-count occurrences (header + gate pill share the data key).
    for (const el of root.querySelectorAll<HTMLElement>('[data-review="verified-count"]')) {
      el.textContent = String(verified.size);
    }
    for (const el of root.querySelectorAll<HTMLElement>('[data-review="resolved-count"]')) {
      el.textContent = String(resolved.size);
    }
    const allVerified = verified.size === behaviorCount;
    const allResolved = resolved.size === deferralCount;

    const pillVerified = root.querySelector<HTMLElement>('[data-review="pill-verified"]');
    if (pillVerified !== null) {
      pillVerified.classList.toggle("ok", allVerified);
      pillVerified.classList.toggle("warn", !allVerified);
    }
    const pillDeferred = root.querySelector<HTMLElement>('[data-review="pill-deferred"]');
    if (pillDeferred !== null) {
      pillDeferred.classList.toggle("ok", allResolved);
      pillDeferred.classList.toggle("warn", !allResolved);
    }

    const canSignOff = ciGreen && allVerified && allResolved;
    const note = root.querySelector<HTMLElement>('[data-review="gate-note"]');
    if (note !== null) {
      note.textContent = canSignOff
        ? "· ready to sign off"
        : "· can't sign off until ci, behaviors + deferrals are settled";
    }
    const nudge = root.querySelector<HTMLElement>('[data-review="nudge"]');
    if (nudge !== null) {
      const left = behaviorCount - verified.size;
      if (left > 0) {
        nudge.textContent = `${left} behavior(s) left to eyeball. Tick each one as you verify it.`;
      } else if (allResolved) {
        nudge.textContent = "All behaviors verified ✓. Deferrals settled. Ready to sign off.";
      } else {
        nudge.textContent = "All behaviors verified ✓. Settle the deferrals to unlock sign-off.";
      }
    }
    // Sign-off stays disabled in v0 regardless (merge integration is a later surface),
    // but we reflect the readiness intent on the title for clarity.
    for (const btn of root.querySelectorAll<HTMLElement>('[data-review="signoff"]')) {
      btn.setAttribute(
        "title",
        canSignOff
          ? "merge integration · not wired in v0 — Phase 3 (review is otherwise ready)"
          : "merge integration · not wired in v0 — Phase 3",
      );
    }
  };

  // device-tab switching re-widths the live preview iframe (or its
  // empty-state placeholder). Tabs carry a `data-width` (CSS max-width); the
  // active tab gets the `.active` class. No server round-trip — pure view state.
  const previewFrame =
    root.querySelector<HTMLElement>('[data-review="preview-frame"]') ??
    root.querySelector<HTMLElement>('[data-review="preview-empty"]');
  const deviceTabs = root.querySelectorAll<HTMLElement>('[data-review="device-tabs"] button');
  const selectDevice = (tab: HTMLElement): void => {
    for (const t of deviceTabs) t.classList.toggle("active", t === tab);
    if (previewFrame !== null) previewFrame.style.maxWidth = tab.dataset["width"] ?? "none";
  };

  root.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;

    const deviceTab = target.closest<HTMLElement>('[data-review="device-tabs"] button');
    if (deviceTab !== null) {
      selectDevice(deviceTab);
      return;
    }

    const behavior = target.closest<HTMLElement>("[data-review-behavior]");
    if (behavior !== null) {
      const id = behavior.dataset["reviewBehavior"] ?? "";
      const nowDone = !verified.has(id);
      if (nowDone) verified.add(id);
      else verified.delete(id);
      behavior.classList.toggle("done", nowDone);
      const check = behavior.querySelector<HTMLElement>(".check");
      if (check !== null) check.textContent = nowDone ? "✓" : "";
      const you = behavior.querySelector<HTMLElement>("[data-review-you]");
      if (you !== null) you.textContent = nowDone ? "you ✓" : "you ○";
      recompute();
      return;
    }

    const resolve = target.closest<HTMLElement>("[data-resolve]");
    if (resolve !== null) {
      const card = resolve.closest<HTMLElement>("[data-review-deferral]");
      if (card === null) return;
      const id = card.dataset["reviewDeferral"] ?? "";
      const label = resolve.dataset["resolve"] ?? "resolved";
      resolved.set(id, label);
      card.style.opacity = "0.6";
      const badge = card.querySelector<HTMLElement>("[data-review-resolved]");
      if (badge !== null) {
        badge.hidden = false;
        badge.textContent = `✓ ${label}`;
      }
      const actions = card.querySelector<HTMLElement>("[data-review-deferral-actions]");
      if (actions !== null) actions.hidden = true;
      recompute();
    }
  });

  recompute();
}
