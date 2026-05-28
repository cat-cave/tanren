// view-failure.jsx — 07 · Failure Recovery. Halted runs only.

window.FailureView = ({ onNav }) => (
  <>
    <PageHead
      eyebrow={<span style={{ color: "var(--status-fail)" }}>▮ run halted · escape hatch reached</span>}
      title={<>get the <em>engine</em> moving again</>}
      sub={<>run_a347d4 · spec_a4f · 3 of 3 retries exhausted · 12m 18s elapsed · $0.84 spent</>}
      actions={
        <>
          <span className="pill fail"><span className="d"></span>halted</span>
          <button className="btn ghost" onClick={() => onNav?.("project")}>← back to project</button>
        </>
      }
    />
    <div className="page-body scrolls">
      <div className="fail-context">
        <div className="cell danger">
          <div className="l">what blocked it</div>
          <div className="v">auditor disagrees with writer · 3×</div>
          <div className="s">writer says behavior 5 demonstrates · auditor says race still possible</div>
        </div>
        <div className="cell">
          <div className="l">last good state</div>
          <div className="v">commit <code style={{ color: "var(--ember-08)", fontFamily: "var(--font-mono)" }}>9f3a2b4</code></div>
          <div className="s">14m ago · before subtask 3</div>
        </div>
        <div className="cell">
          <div className="l">blocks downstream</div>
          <div className="v"><b style={{ color: "var(--ember-08)" }}>5 specs</b> waiting</div>
          <div className="s">pick list · scan · confirm · push · m4 finish</div>
        </div>
        <div className="cell">
          <div className="l">elapsed at hatch</div>
          <div className="v">12m 18s · 3 retries</div>
          <div className="s">$0.84 burned · escape hatch fired</div>
        </div>
      </div>

      <div className="split-row" style={{ gridTemplateColumns: "1.3fr 1fr", minHeight: 520 }}>
        <ForgeChat
          title="recovery"
          meta="read 11 files · last 3 runs · 14 events"
          placeholder='steer · "rollback to 9f3a2b4" · "show the auditor verdicts" · "what if I drop behavior 5?"'
          hint={<><span style={{ color: "var(--status-fail)" }}>↑ engine paused</span><span style={{ margin: "0 8px" }}>·</span><span>nothing moves until you pick a recovery</span></>}
        >
          <Turn>
            The loop hit the escape hatch. <b style={{ color: "var(--status-fail)" }}>Auditor + writer disagreed three times</b> on whether behavior 5 (no SSR theme flash) is reliably demonstrated. Each retry, the writer added more defensiveness; each retry, the auditor found a new edge case.
          </Turn>
          <Turn>
            I think this is a <b style={{ color: "var(--ember-08)" }}>spec problem, not a code problem</b>. Behavior 5's "no flash" criterion is ambiguous — there's no test that can actually fail when a flash happens client-side. The auditor and writer are both right; they're disagreeing about what "demonstrated" means.
            <div className="col-card live" style={{ marginTop: 10, padding: 12, gap: 4 }}>
              <div className="h">recommended path</div>
              <div style={{ fontFamily: "var(--font-ui)", fontSize: 13, color: "var(--fg-1)", lineHeight: 1.5 }}>
                <b>revise the spec</b> · split behavior 5 into two: (a) html renders correct theme on first paint (verifiable via DOM snapshot), (b) no client flash within 200ms (verifiable via playwright trace). Then replan and continue.
              </div>
              <InlineActions>
                <button className="btn primary notched" style={{ fontSize: 11 }}>apply this · revise + replan</button>
                <button className="btn ghost" style={{ fontSize: 11 }}>show me the disagreement</button>
              </InlineActions>
            </div>
          </Turn>
          <Turn>Other ways out (right rail) — or steer me yourself.</Turn>
        </ForgeChat>

        <div className="scroll-col">
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ember-08)", letterSpacing: "0.22em", textTransform: "uppercase", fontWeight: 700 }}>▮ recovery options · pick one</div>

          <div className="recovery-card recommended">
            <span className="rec-tape">forge recommends</span>
            <div className="lbl">revise the spec</div>
            <div className="t">split or redefine the failing criterion</div>
            <div className="det">most useful when writer ↔ auditor disagree on what "done" means. forge proposes a re-scope; you accept or refine; loop returns to plan with the new criteria.</div>
            <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
              <button className="btn primary notched" style={{ fontSize: 11 }}>open revision pane ↗</button>
              <button className="btn ghost" style={{ fontSize: 11 }}>split · 5 → 5a + 5b</button>
            </div>
          </div>

          <div className="recovery-card">
            <div className="lbl">replan with instructions</div>
            <div className="t">send back to planner · with steering</div>
            <div className="det">same spec, fresh plan, with your instructions. useful when the spec is right but the agent's approach was wrong.</div>
            <div style={{ marginTop: 4, padding: "8px 10px", background: "var(--bg-sunken)", border: "1px dashed var(--line-2)", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-3)", borderRadius: 2 }}>
              "next time, use a server-side cookie for the first paint instead of inline script…"
            </div>
            <button className="btn" style={{ fontSize: 11, alignSelf: "flex-start" }}>send to planner ↗</button>
          </div>

          <div className="recovery-card">
            <div className="lbl">rollback the code</div>
            <div className="t">revert to a known-good commit</div>
            <div className="det">discards the writer's partial work. last good commit was <code style={{ color: "var(--ember-07)", background: "var(--bg-sunken)", padding: "0 4px", border: "1px solid var(--line-1)", fontSize: 11 }}>9f3a2b4</code> before subtask 3.</div>
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 4 }}>
              <div style={{ flex: 1, padding: "5px 9px", background: "var(--bg-sunken)", border: "1px solid var(--line-1)", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-1)", borderRadius: 2 }}>9f3a2b4 · 14m ago · before subtask 3 ▾</div>
              <button className="btn danger" style={{ fontSize: 11 }}>rollback ↻</button>
            </div>
          </div>

          <div className="recovery-card">
            <div className="lbl">resolve via conversation</div>
            <div className="t">explore with forge before deciding</div>
            <div className="det">read the auditor's last 3 verdicts side-by-side, the writer's reasoning, the spec text. then decide.</div>
            <button className="btn ghost" style={{ fontSize: 11, color: "var(--ember-08)", alignSelf: "flex-start" }}>open inspection thread ↗</button>
          </div>

          <div className="recovery-card" style={{ background: "var(--bg-sunken)" }}>
            <div className="lbl" style={{ color: "var(--status-fail)" }}>last resort</div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <div style={{ fontFamily: "var(--font-ui)", fontSize: 12, color: "var(--fg-1)" }}>abandon · move spec to backlog</div>
              <button className="btn ghost" style={{ fontSize: 11, color: "var(--status-fail)" }}>cancel run ↗</button>
            </div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--fg-3)", lineHeight: 1.4 }}>workspace preserved · 5 downstream specs stay blocked · revisit later</div>
          </div>
        </div>
      </div>

      <div className="dag-impact">
        <div className="head">
          <span className="lbl">▮ dag impact · while paused</span>
          <span className="meta">~9 days of work waits on resolution</span>
        </div>
        <div className="track">
          <span className="node" style={{ borderColor: "var(--status-fail)", background: "oklch(60% 0.18 25 / 0.10)", color: "var(--status-fail)" }}>× spec_a4f halted</span>
          <span className="sep" style={{ color: "var(--status-fail)" }}>→</span>
          {["pick list ui", "scan item to tote", "confirm scan", "push tote · staging", "m4 finish"].map((n, i) => (
            <React.Fragment key={i}>
              <span className="node old" style={{ opacity: 0.55 }}>○ {n}</span>
              {i < 4 && <span className="sep">→</span>}
            </React.Fragment>
          ))}
        </div>
      </div>
    </div>
  </>
);
