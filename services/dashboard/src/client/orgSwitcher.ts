/**
 * Org-pill project-switcher island. Toggles the dropdown menu open/closed on
 * the org pill, closes on outside-click and Escape. Switching is a plain
 * anchor navigation (the menu items are <a href="/projects/:id">), so the
 * server re-renders the shell with the new project crumb — no client routing.
 */

export function initOrgSwitcher(): void {
  const wrap = document.querySelector('[data-island="org-switcher"]');
  if (wrap === null) return;
  const trigger = wrap.querySelector<HTMLButtonElement>('[data-island-trigger="org-switcher"]');
  const menu = wrap.querySelector<HTMLElement>('[data-island-menu="org-switcher"]');
  if (trigger === null || menu === null) return;

  const close = (): void => {
    menu.hidden = true;
  };
  const open = (): void => {
    menu.hidden = false;
  };

  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    if (menu.hidden) open();
    else close();
  });

  document.addEventListener("click", (event) => {
    if (!wrap.contains(event.target as Node)) close();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
}
