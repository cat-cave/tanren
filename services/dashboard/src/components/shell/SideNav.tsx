/**
 * SideNav — server-rendered shell chrome (Hono JSX). Recreates the hi-fi
 * `SideNav`: three groups (org / projects / system) read from the
 * `NAV_GROUPS` model. Rows whose surface ships in a later phase render with a
 * visible `phase 3+` label (the documented-placeholder marker). The active row
 * is highlighted from `activeId`.
 *
 * Project-scoped rows substitute the active project id into their `:projectId`
 * placeholder; with no active project they fall back to the project list.
 */

import { NAV_GROUPS, type NavRow } from "../../app/routes.js";

export interface SideNavProps {
  /** Active nav row id (drives the highlight). */
  activeId: string | undefined;
  /** Active project id, substituted into project-scoped row paths. */
  activeProjectId: string | undefined;
}

function hrefFor(row: NavRow, activeProjectId: string | undefined): string {
  if (row.path.includes(":projectId")) {
    if (activeProjectId === undefined) {
      return "/projects";
    }
    return row.path.replace(":projectId", activeProjectId);
  }
  return row.path;
}

function Row(props: { row: NavRow; activeId: string | undefined; activeProjectId: string | undefined }) {
  const { row } = props;
  const isActive = props.activeId === row.id;
  const isPlaceholder = row.phase !== "2b";
  return (
    <a class={isActive ? "active" : ""} href={hrefFor(row, props.activeProjectId)} data-nav-id={row.id}>
      <span
        class={`glyph${row.kanji ? " kanji" : ""}`}
        style={row.kanji ? "font-family: var(--font-jp); font-size: 13px; color: var(--ember-08)" : ""}
      >
        {row.glyph}
      </span>
      {row.label}
      {isPlaceholder && <span class="soon">phase 3+</span>}
    </a>
  );
}

export function SideNav(props: SideNavProps) {
  return (
    <nav class="sidenav">
      {NAV_GROUPS.map((group, index) => (
        <>
          <div class="group-label" style={index === 0 ? "" : "margin-top: 8px"}>
            ▮ {group.label}
          </div>
          {group.rows.map((row) => (
            <Row row={row} activeId={props.activeId} activeProjectId={props.activeProjectId} />
          ))}
        </>
      ))}
    </nav>
  );
}
