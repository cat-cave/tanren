/**
 * ForgePalette — the ⌘K overlay modal (server-rendered shell chrome). Recreates
 * the hi-fi `ForgePalette`: a search input + grouped results sourced from the
 * orchestrator Forge tool surface (P2A-0019), which MORPHS IN PLACE into a chat
 * thread (P3-0010). Quick actions and ask-forge prompts carry a `route` (read
 * action → navigate); forge-this items carry a `tool` (write action → operator
 * button endpoint).
 *
 * Two modes share one modal:
 *   - palette mode — grouped results, type-to-filter, ↑/↓ navigate, ↵ select.
 *   - chat mode    — a real thread: the island sends the question to the
 *     thick-Forge conversation endpoint (via `/forge/ask`), renders forge turns
 *     (answer bubbles), follow-up chips, and auto-navigate action cards.
 *
 * The server renders the palette item list + the (empty, hidden) chat scaffold;
 * the island (`client/palette.ts`) owns open/close, filter, navigation, the
 * morph to chat-mode, and the fetch/render of turns. Read/navigation actions
 * auto-navigate; proposed WRITE actions render as LIVE approve/reject cards
 * (P3-0010 write-action approval) — the island POSTs the decision to the
 * dashboard's `/forge/proposals/{approve,reject}` proxy, and the orchestrator
 * executes the write under the approving operator's authz.
 */

import type { PaletteGroup } from "../../api/types.js";

export interface ForgePaletteProps {
  groups: PaletteGroup[];
  /** Org id the write tools + chat thread are invoked against. */
  orgId: string | undefined;
  /** Active project id (when on a project surface) — scopes the chat thread. */
  projectId: string | undefined;
}

export function ForgePalette(props: ForgePaletteProps) {
  return (
    <div
      class="forge-backdrop"
      data-island="palette"
      data-org-id={props.orgId ?? ""}
      data-project-id={props.projectId ?? ""}
      hidden
    >
      <div class="forge-modal" data-palette-modal>
        <div class="input-row">
          <span class="stamp">鍛</span>
          <button class="fc-back" type="button" data-palette-back title="back to commands" hidden>
            ←
          </button>
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
                  data-ask={item.route === undefined && item.tool === undefined ? "1" : ""}
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
            No command matches. Press ↵ to ask forge in chat.
          </div>
        </div>
        {/* Chat thread — populated by the island when the palette morphs. */}
        <div class="forge-chat" data-palette-chat hidden></div>
        <div class="footer" data-palette-footer-palette>
          <span>↑↓ navigate</span>
          <span>↵ select</span>
          <span>esc close</span>
          <span style="margin-left: auto; color: var(--ember-08)">forge palette · ⌘K</span>
        </div>
        <div class="footer" data-palette-footer-chat hidden>
          <span>↵ send</span>
          <span>← commands</span>
          <span>esc close</span>
          <span style="margin-left: auto; color: var(--ember-08)">forge · chat</span>
        </div>
      </div>
    </div>
  );
}
