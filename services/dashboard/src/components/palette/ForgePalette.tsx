/**
 * ForgePalette — the ⌘K overlay modal (server-rendered shell chrome). Recreates
 * the hi-fi `ForgePalette`: a search input + grouped results sourced from the
 * orchestrator Forge tool surface (P2A-0019). Quick actions and ask-forge
 * prompts carry a `route` (read action → navigate); forge-this items carry a
 * `tool` (write action → operator-button endpoint).
 *
 * The server renders the full item list and embeds it as JSON for the client
 * island, which owns open/close, type-to-filter, ↑/↓ navigation, and select.
 * The modal starts hidden; the island toggles `hidden` on ⌘K / trigger / close.
 */

import type { PaletteGroup } from "../../api/types.js";

export interface ForgePaletteProps {
  groups: PaletteGroup[];
  /** Org id the write tools are invoked against. */
  orgId: string | undefined;
}

export function ForgePalette(props: ForgePaletteProps) {
  return (
    <div class="forge-backdrop" data-island="palette" data-org-id={props.orgId ?? ""} hidden>
      <div class="forge-modal" data-palette-modal>
        <div class="input-row">
          <span class="stamp">鍛</span>
          <input
            type="text"
            data-palette-input
            placeholder="ask, command, or describe…"
            autocomplete="off"
            spellcheck={false}
          />
          <span class="esc">esc</span>
        </div>
        <div class="results" data-palette-results>
          {props.groups.map((group) => (
            <>
              <div class="group" data-group={group.group}>
                ▮ {group.group}
              </div>
              {group.items.map((item) => (
                <div
                  class="item"
                  data-palette-item
                  data-title={item.title.toLowerCase()}
                  data-desc={item.desc.toLowerCase()}
                  data-route={item.route ?? ""}
                  data-tool={item.tool ?? ""}
                  data-args={item.args ? JSON.stringify(item.args) : ""}
                >
                  <div class={`glyph${item.kanji ? " kanji" : ""}`}>{item.glyph}</div>
                  <div>
                    <div class="t">{item.title}</div>
                    <div class="d">{item.desc}</div>
                  </div>
                  <div class="k">↵</div>
                </div>
              ))}
            </>
          ))}
          <div class="palette-empty" data-palette-empty hidden>
            No matches. Press ↵ to ask forge anyway.
          </div>
        </div>
        <div class="footer">
          <span>↑↓ navigate</span>
          <span>↵ select</span>
          <span>esc close</span>
          <span style="margin-left: auto; color: var(--ember-08)">forge palette · ⌘K</span>
        </div>
      </div>
    </div>
  );
}
