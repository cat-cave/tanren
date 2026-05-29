/**
 * Theme island: the ink/ash surface toggle. Flips `data-theme` on <html>
 * (ink → "dark", ash → default/light to match tokens.css), persists the choice
 * to localStorage AND a cookie (so the server can render the right initial
 * theme), and reflects the active button. No hardcoded colors — only the
 * `data-theme` attribute is touched; tokens.css does the rest.
 */

type Surface = "ink" | "ash";

const STORAGE_KEY = "tanren_surface";

function applySurface(surface: Surface): void {
  const root = document.documentElement;
  if (surface === "ink") {
    root.dataset['theme'] = "dark";
  } else {
    delete root.dataset['theme'];
  }
  for (const btn of document.querySelectorAll<HTMLButtonElement>("[data-theme-value]")) {
    btn.classList.toggle("active", btn.dataset['themeValue'] === surface);
  }
}

function persist(surface: Surface): void {
  try {
    localStorage.setItem(STORAGE_KEY, surface);
  } catch {
    // localStorage may be unavailable (private mode); cookie still carries it.
  }
  document.cookie = `${STORAGE_KEY}=${surface}; path=/; max-age=31536000; samesite=lax`;
}

function currentSurface(): Surface {
  const root = document.documentElement;
  return root.dataset['theme'] === "dark" ? "ink" : "ash";
}

export function initTheme(): void {
  const toggle = document.querySelector('[data-island="theme-toggle"]');
  if (toggle === null) return;

  // Reconcile the server-rendered theme with a stored preference, if any.
  let stored: Surface | undefined;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "ink" || raw === "ash") stored = raw;
  } catch {
    stored = undefined;
  }
  applySurface(stored ?? currentSurface());

  toggle.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-theme-value]");
    if (target === null) return;
    const surface = target.dataset['themeValue'] === "ash" ? "ash" : "ink";
    applySurface(surface);
    persist(surface);
  });
}
