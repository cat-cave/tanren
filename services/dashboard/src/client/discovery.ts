/**
 * P3-0014 discovery island. Hydrates the server-rendered classification panel:
 * clicking a DAG-placement option selects it (highlights the card + writes the
 * chosen kind/label into the accept form's hidden inputs + the "placement ·"
 * caption). No server round-trip for selection — the accept itself is a real
 * form POST handled server-side, mirroring the P2B/P3 island convention
 * (interactivity is local; writes go through the server). No-op when the
 * discovery markup is absent.
 */

export function initDiscovery(): void {
  const root = document.querySelector<HTMLElement>('[data-island="discovery"]');
  if (root === null) return;

  const kindInput = root.querySelector<HTMLInputElement>('[data-discovery="placement-kind"]');
  const labelInput = root.querySelector<HTMLInputElement>('[data-discovery="placement-label"]');
  const chosen = root.querySelector<HTMLElement>('[data-discovery="placement-chosen"]');
  const options = root.querySelectorAll<HTMLElement>('[data-discovery="placement"]');

  const select = (opt: HTMLElement): void => {
    for (const o of options) o.classList.toggle("sel", o === opt);
    const kind = opt.dataset.placementKind ?? "slot_after";
    const label = opt.dataset.placementLabel ?? "";
    if (kindInput !== null) kindInput.value = kind;
    if (labelInput !== null) labelInput.value = label;
    if (chosen !== null) chosen.textContent = `placement · ${label}`;
  };

  root.addEventListener("click", (event) => {
    const opt = (event.target as HTMLElement).closest<HTMLElement>('[data-discovery="placement"]');
    if (opt !== null) {
      event.preventDefault();
      select(opt);
    }
  });
}
