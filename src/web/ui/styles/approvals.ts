/**
 * There is one allow button per scope and length (approval-request.ts,
 * `allowButtons`); this shows the one matching the chosen radios, so the
 * only button on screen says what it does.
 */
const ALLOW_BUTTON_CSS = ["exact_call", "rule", "run"]
  .flatMap((scope) =>
    ["1h", "1d", "7d", "30d"].map(
      (length) =>
        `.ap-split:has(input[type="radio"][name="scope"][value="${scope}"]:checked):has(input[type="radio"][name="duration"][value="${length}"]:checked) .ap-allow-btn[data-scope="${scope}"][data-duration="${length}"]{display:flex}`,
    ),
  )
  .join("\n");

/** Styles for the approvals page, appended to the shared stylesheet in theme.ts. */
export const APPROVALS_CSS = `
.req-section{margin:1.25rem 0 0}
.req-section-title{display:flex;align-items:center;gap:.5rem;font-size:.95rem;font-weight:600;margin:0 0 .5rem;color:var(--text)}
.req-section-count{display:inline-block;min-width:1.4rem;padding:0 .45rem;border-radius:999px;background:var(--surface);box-shadow:inset 0 0 0 1px var(--line);color:var(--muted);font-size:.75rem;line-height:1.4rem;text-align:center}
.req-group{list-style:none;margin:0 0 .5rem;padding:0;border:1px solid var(--line);border-radius:14px;background:var(--bg);overflow:hidden;box-shadow:0 1px 2px rgb(0 0 0 / .04)}
.req-group > .req + .req{border-top:1px solid var(--line)}
.req-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto;align-items:center;gap:.25rem 1rem;padding:.85rem 1rem;color:var(--text);text-decoration:none;transition:background-color .15s}
.req-row:hover,.req-row:focus-visible{background:color-mix(in srgb,var(--surface) 60%,transparent)}
.req-row:focus-visible{outline-offset:-3px}
.req-body{min-width:0;display:flex;flex-direction:column}
.req .ap-meta{display:flex;flex-wrap:wrap;align-items:center;gap:.1rem .6rem;font-size:.85rem;line-height:1.5}
.req .ap-meta > *{display:inline;margin:0;white-space:nowrap}
.req .ap-meta .badge{float:none;margin:0}
.req-title{display:block;font-size:1.02rem;line-height:1.4;margin:.2rem 0 0;font-weight:600;overflow-wrap:anywhere}
.req-reason{display:block;margin:.35rem 0 0;padding-left:.75rem;border-left:2px solid var(--line);font-size:.9rem}
.req-foot{display:block;margin:.3rem 0 0;font-size:.82rem}
.req-review{opacity:0;font-size:.82rem;font-weight:500;padding:.3rem .75rem;border-radius:8px;border:1px solid var(--line);background:var(--bg);white-space:nowrap;transition:opacity .15s}
.req-row:hover .req-review,.req-row:focus-visible .req-review{opacity:1}
.req-icon{display:inline-flex;flex:none}
.req-go{display:inline-flex;color:var(--muted)}
.req-go svg{width:1.1rem;height:1.1rem}
.req-section:not(:first-of-type) .req-row{opacity:.92}
@media (max-width:36rem){
  .req-row{grid-template-columns:auto minmax(0,1fr) auto;align-items:start;padding:.8rem .85rem;gap:.25rem .75rem}
  .req-review{display:none}
  .req-go{align-self:center}
  .req-icon .svc-logo{width:2rem;height:2rem}
}
.req-empty{display:flex;flex-direction:column;align-items:center;text-align:center;gap:.3rem;padding:3.5rem 1rem}
.req-empty p{margin:0}
.req-empty-icon{display:inline-grid;place-items:center;width:2.75rem;height:2.75rem;border-radius:999px;background:var(--ok-bg);color:var(--ok);margin-bottom:.4rem}
.req-empty-icon svg{width:1.4rem;height:1.4rem}
.req-empty-title{font-weight:600;font-size:1.05rem}

/* ── Shared action bar (.ap-bar), rendered by actionBar() in approval-shell.ts ──
   Every approval page uses it: no on the left, yes on the right, side by side at
   every width. Slots: .ap-bar-yes, .ap-bar-no; note: .ap-bar-note. On phones,
   .ap[data-dock="pinned"] .ap-bar[data-dock] pins it to the bottom in place of the tab bar. */
.ap-bar{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:.6rem}
.ap-bar > span{display:flex;min-width:0}
.ap-bar-no{order:1}
.ap-bar-yes{order:2}
.ap-bar form{display:flex;flex:1;margin:0;min-width:0}
.ap-bar .btn{width:100%;flex:1;min-width:0;white-space:normal;height:auto;min-height:2.5rem}
.ap-bar [data-heel-ceremony="deny"]{background:var(--bg)}
.ap-bar-note{margin:.45rem 0 0;font-size:.8rem;text-align:center}
@media (max-width:55.99rem){
  /* Pinned: the bar takes the tab bar's place at the bottom of a phone screen while a decision is open. */
  .ap[data-dock="pinned"] .ap-bar[data-dock]{position:fixed;left:0;right:0;bottom:0;z-index:31;padding:.75rem max(.75rem,var(--heel-safe-right,env(safe-area-inset-right))) calc(.75rem + var(--heel-safe-bottom,env(safe-area-inset-bottom))) max(.75rem,var(--heel-safe-left,env(safe-area-inset-left)));background:color-mix(in srgb,var(--bg) 94%,transparent);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-top:1px solid var(--line);box-shadow:0 -10px 30px -18px rgb(0 0 0 / .35)}
  .ap[data-dock="pinned"] .ap-bar[data-dock] .btn{min-height:2.75rem}
  body.app:has(.ap[data-dock="pinned"] .ap-bar[data-dock]) > .site nav{display:none}
  body.app:has(.ap[data-dock="pinned"] .ap-bar[data-dock]){padding-bottom:calc(5rem + var(--heel-safe-bottom,env(safe-area-inset-bottom)))}
  body:has(.ap[data-dock="pinned"] .ap-bar[data-dock]) #heel-ceremony-status:not(:empty){bottom:calc(5.5rem + var(--heel-safe-bottom,env(safe-area-inset-bottom)))}
}
/* ── End of the shared action bar ── */

/* ── Call approval page (approval-request.ts) ──
   Top to bottom: who asks, the one sentence, the agent's words, one note, the content,
   then the bar. A decided request leads with .ap-outcome. Top-level folds share one
   name, so one is open at a time; the approve menu opens upward, over the page. */
.ap{max-width:42rem;margin:0 auto}
.ap-crumbs{display:flex;margin:0 0 .75rem;font-size:.88rem}
.ap-crumbs a{display:inline-flex;align-items:center;gap:.3rem;color:var(--muted);text-decoration:none;border-radius:6px}
.ap-crumbs a:hover{color:var(--text)}
.ap-crumbs a svg{width:.95rem;height:.95rem}
.ap-who{display:flex;align-items:center;gap:.5rem;font-size:.9rem;min-width:0}
.ap-avatar{flex:none;display:inline-grid;place-items:center;width:1.5rem;height:1.5rem;border-radius:999px;font-size:.75rem;font-weight:700;color:hsl(var(--hue) 60% 36%);background:hsl(var(--hue) 70% 50% / .16)}
:root[data-theme="dark"] .ap-avatar{color:hsl(var(--hue) 70% 74%)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .ap-avatar{color:hsl(var(--hue) 70% 74%)}}
.ap-who .ap-agent{font-weight:600;color:var(--text);overflow-wrap:anywhere;min-width:0}
.ap-soon{margin-left:auto;color:var(--warn);font-size:.82rem;font-weight:500;white-space:nowrap}
.ap .ap-title{font-size:1.35rem;line-height:1.3;margin:.4rem 0 0;letter-spacing:-.02em;font-weight:650;overflow-wrap:anywhere}
.ap.is-decided .ap-title{font-size:1rem;font-weight:600;letter-spacing:0}
.ap .notice{margin:.75rem 0 0}
.ap .ap-why{margin:.9rem 0 0;padding:.55rem .85rem;border:0;border-left:3px solid color-mix(in srgb,var(--muted) 45%,transparent);background:var(--surface);border-radius:0 10px 10px 0}
.ap-why figcaption{display:flex;align-items:center;gap:.4rem;font-size:.78rem;color:var(--muted);margin:0 0 .15rem}
.ap-unchecked{font-size:.7rem;padding:0 .45rem;border-radius:999px;box-shadow:inset 0 0 0 1px var(--line)}
.ap-why blockquote{margin:0;font-size:.95rem;line-height:1.5;overflow-wrap:anywhere}
.ap-taskrow{display:flex;align-items:center;gap:.45rem;margin:.75rem 0 0;font-size:.86rem;color:var(--muted)}
.ap-taskrow-icon{display:inline-flex}
.ap-taskrow-icon svg{width:1rem;height:1rem}
.ap-taskrow a{margin-left:auto;color:var(--text);font-weight:500;border-radius:6px}
.ap-risk{display:flex;gap:.55rem;align-items:flex-start;margin:.75rem 0 0;padding:.55rem .8rem;border-radius:10px;background:var(--warn-bg);font-size:.9rem;overflow-wrap:anywhere}
.ap-risk-icon{flex:none;display:inline-flex;color:var(--warn);margin-top:.15rem}
.ap-risk-icon svg{width:1rem;height:1rem}
.ap-risk-word{color:var(--warn);font-weight:700}
.ap-check-hints{list-style:none;margin:.5rem 0 0;padding:0;display:grid;gap:.3rem;font-size:.86rem}
.ap-check-hints li{display:flex;align-items:baseline;gap:.45rem}
.ap-content,.ap-task{margin:.9rem 0 0;padding:.85rem 1rem;border:1px solid var(--line);border-radius:14px;background:var(--bg);box-shadow:0 1px 2px rgb(0 0 0 / .04);min-width:0}
.ap-content-title{font-size:.78rem;font-weight:600;color:var(--muted);margin:0 0 .35rem}
.ap-row{display:grid;grid-template-columns:4.25rem minmax(0,1fr);gap:.6rem;padding:.2rem 0;align-items:baseline;font-size:.93rem}
.ap-key{color:var(--muted);font-size:.85rem;overflow-wrap:anywhere}
.ap-val{min-width:0;overflow-wrap:anywhere}
.ap-none{margin:.15rem 0 0 4.85rem;color:var(--muted);font-size:.85rem}
.ap-email[data-layout="mail"] .ap-subject{display:block;margin:.55rem 0 0;padding:.55rem 0 0;border-top:1px solid var(--line)}
.ap-email[data-layout="mail"] .ap-subject .ap-key{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.ap-email[data-layout="mail"] .ap-subject strong{font-size:1.02rem}
.ap-email[data-layout="rows"] .ap-row{grid-template-columns:1fr;gap:.05rem;padding:.45rem 0;border-top:1px solid var(--line)}
.ap-email[data-layout="rows"] .ap-row:first-of-type{border-top:0}
.ap-email[data-layout="rows"] .ap-none{margin:0;padding:.45rem 0;border-top:1px solid var(--line)}
.ap-email[data-layout="rows"] .ap-mail{margin-top:.3rem;padding:.6rem .75rem;border:1px solid var(--line);border-radius:10px}
.ap-mail{margin:.4rem 0 0}
.ap-mail pre.body{margin:0;padding:0;border:0;background:none;font-family:inherit;font-size:.93rem;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}
.ap-domains,.ap-addresses{list-style:none;margin:0;padding:0;display:grid;gap:.2rem}
.ap-addresses{margin-top:.3rem;font-size:.9rem}
.ap-chip{overflow-wrap:anywhere}
.ap-chip.is-outside{text-decoration:underline;text-decoration-color:var(--warn);text-underline-offset:3px}
.ap-outside{color:var(--warn);font-size:.75rem;font-weight:600}
.ap-files{list-style:none;margin:.6rem 0 0;padding:0;display:flex;flex-wrap:wrap;gap:.4rem}
.ap-file{display:inline-flex;align-items:center;gap:.4rem;padding:.3rem .6rem;border:1px solid var(--line);border-radius:8px;background:var(--surface);font-size:.85rem;max-width:100%;overflow-wrap:anywhere}
.ap-file-icon{flex:none;display:inline-flex;color:var(--muted)}
.ap-file-icon svg{width:.9rem;height:.9rem}
.ap-args-view pre.body{font-size:.85rem;padding:.5rem .65rem}
.ap-note{margin:.35rem 0 0;font-size:.82rem;color:var(--muted)}
.ap-sha{word-break:break-all}
.ap-steps{list-style:none;margin:0;padding:0;display:grid;gap:.3rem;font-size:.9rem;counter-reset:step}
.ap-steps li{display:flex;gap:.5rem;align-items:baseline;counter-increment:step}
.ap-steps li::before{content:counter(step);flex:none;width:1.25rem;height:1.25rem;display:inline-grid;place-items:center;border-radius:999px;background:var(--surface);font-size:.72rem;color:var(--muted)}
.ap-steps li.is-now{font-weight:600}
.ap-step-done{margin-left:auto;color:var(--muted);font-size:.8rem;font-weight:400;white-space:nowrap}

/* Folds: closed by default, one open at a time (shared name), Technical the only level inside Details. */
.ap details > summary{display:flex;align-items:center;justify-content:flex-start;gap:.3rem;list-style:none;cursor:pointer;border-radius:8px}
.ap details > summary::-webkit-details-marker{display:none}
.ap .chev{flex:none;display:inline-flex;color:var(--muted);transition:transform .2s}
.ap .chev svg{width:1rem;height:1rem}
.ap details[open] > summary .chev{transform:rotate(180deg)}
@media (prefers-reduced-motion:reduce){.ap .chev{transition:none}}
.ap > .ap-fold,.ap-task > .ap-fold{margin:.6rem 0 0}
.ap > .ap-fold > summary,.ap-task > .ap-fold > summary,.ap-technical > summary,.ap-mail-more > summary{padding:.3rem 0;color:var(--muted);font-size:.86rem;font-weight:500}
.ap > .ap-fold > summary:hover,.ap-task > .ap-fold > summary:hover,.ap-technical > summary:hover{color:var(--text)}
.ap > .ap-details{margin-top:1rem;padding-top:.5rem;border-top:1px solid var(--line)}
.ap-fold-body{padding:.35rem 0 .25rem}
.ap-details .ap-row{grid-template-columns:6.5rem minmax(0,1fr);font-size:.88rem}
.ap-technical{margin:.6rem 0 0}
.ap-technical dl.facts{grid-template-columns:6.5rem minmax(0,1fr);gap:.25rem .75rem;font-size:.8rem;margin:.35rem 0 0}
.ap-technical dl.facts dt{font-weight:500}
.ap-sub{font-size:.8rem;font-weight:600;color:var(--muted);margin:.6rem 0 .3rem}
.ap .ap-args pre.args{font-size:.8rem;margin-top:.35rem}

/* The decision. Phones: the shared bar pins it. Wide screens: it sticks to the bottom of the window. */
.ap-decide{margin:1rem 0 0}
@media (min-width:56rem){.ap-decide{position:sticky;bottom:0;z-index:5;padding:.75rem 0 1rem;background:linear-gradient(to bottom,transparent,var(--page) 35%)}}
.ap-decide > .ap-note{text-align:center}
/* Approve once, with a menu for approving for longer: one primary button, labelled with the choice. */
.ap-split{position:relative;display:flex;flex:1;min-width:0}
/* !important: shadcn's utilities sit in a later cascade layer than these rules. */
/* The label keeps room on both sides of the divider and stays on one line. */
.ap-split .btn{border-top-right-radius:0 !important;border-bottom-right-radius:0 !important;padding-left:.85rem !important;padding-right:.85rem !important;white-space:nowrap !important}
.ap-split:has(input[type="radio"][name="scope"]:not([value="once"]):checked) > [data-heel-ceremony="approve-once"]{display:none !important}
.ap-allow-btn{display:none;flex:1;min-width:0}
${ALLOW_BUTTON_CSS}
/* An allow label is longer than "Approve once": the approve side takes 3 parts to Deny's 2. */
.ap[data-kind="call"] .ap-bar:has(.ap-split input[type="radio"][name="scope"]:not([value="once"]):checked){grid-auto-columns:unset;grid-template-columns:minmax(0,2fr) minmax(0,3fr)}
.ap-split-menu{flex:none;display:flex}
.ap .ap-split-toggle{display:inline-grid;place-items:center;width:2.75rem;min-height:2.5rem;height:100%;padding:0 .7rem;border-radius:0 6px 6px 0;background:var(--accent);color:var(--accent-text);box-shadow:inset 1px 0 0 color-mix(in srgb,var(--accent-text) 25%,transparent)}
.ap .ap-split-toggle svg{width:1rem;height:1rem;transition:transform .2s}
.ap .ap-split-menu[open] > .ap-split-toggle svg{transform:rotate(180deg)}
.ap-split:has(:disabled) .ap-split-toggle{opacity:.5;pointer-events:none}
.ap-menu{position:absolute;right:0;bottom:calc(100% + .5rem);z-index:40;width:min(22rem,calc(100vw - 1.5rem));max-height:min(70vh,30rem);overflow:auto;padding:.85rem;border:1px solid var(--line);border-radius:14px;background:var(--bg);color:var(--text);box-shadow:0 18px 50px -12px rgb(0 0 0 / .35)}
fieldset.ap-allow{border:0;padding:0;margin:0;min-width:0}
.ap-allow legend{padding:0;margin:0 0 .4rem;font-weight:600;font-size:.9rem}
.ap-allow .choice{display:flex;gap:.55rem;align-items:flex-start;padding:.45rem .55rem;border-radius:10px;margin:0 0 .25rem;font-size:.9rem;cursor:pointer}
.ap-allow .choice input{margin-top:.25rem}
.ap-allow .choice:has(input:checked){background:var(--surface)}
.ap-allow .choice.is-broad{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--warn) 35%,transparent)}
.ap-broad{display:inline-block;margin-left:.2rem;padding:0 .45rem;border-radius:999px;background:var(--warn-bg);color:var(--warn);font-size:.7rem;font-weight:600}
.ap-pills{display:flex;flex-wrap:wrap;gap:.35rem;margin:.5rem 0 0}
.ap-allow:has(input[value="once"]:checked) .ap-pills,.ap-allow:has(input[value="once"]:checked) > .ap-note{display:none}
.ap-pill{position:relative}
.ap-pill input{position:absolute;inset:0;opacity:0;margin:0;cursor:pointer}
.ap-pill span{display:inline-block;padding:.3rem .75rem;border-radius:999px;box-shadow:inset 0 0 0 1px var(--line);font-size:.85rem}
.ap-pill input:checked + span{background:var(--accent);color:var(--accent-text);box-shadow:none}
.ap-pill input:focus-visible + span{outline:2px solid var(--focus);outline-offset:2px}
/* A decided request: one word, then what was asked, the agent's words, the way back and two folds. */
.ap-outcome{display:flex;gap:.65rem;align-items:center;margin:.25rem 0 .75rem}
.ap-outcome-icon{display:inline-flex}
.ap-back{margin:1rem 0 0}
.ap-back a{color:var(--text);font-weight:500}
.ap-outcome-icon svg{width:1.75rem;height:1.75rem}
.ap-outcome[data-tone="error"] .ap-outcome-icon{color:var(--danger)}
.ap-outcome[data-tone="ok"] .ap-outcome-icon{color:var(--ok)}
.ap-outcome[data-tone="info"] .ap-outcome-icon{color:var(--info)}
.ap-outcome[data-tone="muted"] .ap-outcome-icon{color:var(--muted)}
.ap .ap-outcome-word{font-size:1.75rem;line-height:1.15;margin:0;letter-spacing:-.02em}
/* Focus: a ring only for the keyboard, following each element's own radius. */
.ap :is(a,summary,input,select):focus{outline:none}
.ap :is(a,summary,select):focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.ap input[type="radio"]:focus-visible{outline:2px solid var(--focus);outline-offset:2px;border-radius:999px}
@media (max-width:36rem){
  .ap .ap-title{font-size:1.2rem}
  .ap-content,.ap-task{padding:.75rem .85rem}
}
`;
