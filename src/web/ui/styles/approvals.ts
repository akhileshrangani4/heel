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
.ap-risk{display:flex;gap:.55rem;align-items:flex-start;margin:0 0 .75rem;padding:.6rem .8rem;border-radius:10px;background:var(--warn-bg);color:var(--text);font-size:.92rem;overflow-wrap:anywhere}
.ap-risk-icon{flex:none;display:inline-flex;color:var(--warn);margin-top:.15rem}
.ap-risk-icon svg{width:1rem;height:1rem}
.ap-risk-word{color:var(--warn);font-weight:700}
.ap-crumbs{display:flex;align-items:center;gap:.5rem;margin:0 0 .6rem;font-size:.88rem}
.ap-crumbs a{display:inline-flex;align-items:center;gap:.3rem;color:var(--muted);text-decoration:none}
.ap-crumbs a:hover{color:var(--text)}
.ap-crumbs a svg{width:.95rem;height:.95rem}
.ap-crumbs [aria-current="page"]{color:var(--text);font-weight:500}
.ap-crumbs-status{margin-left:auto}

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
.ap details > summary{display:flex;align-items:center;justify-content:space-between;gap:.75rem;list-style:none;cursor:pointer}
.ap details > summary::-webkit-details-marker{display:none}
.ap details > summary .fold-label{flex:1;min-width:0}
.ap .chev{flex:none;display:inline-flex;color:var(--muted);transition:transform .2s}
.ap .chev svg{width:1rem;height:1rem}
.ap details[open] > summary .chev{transform:rotate(180deg)}
@media (prefers-reduced-motion:reduce){.ap .chev{transition:none}}
.ap-domains details > summary{justify-content:flex-start}
.ap-domains details > summary .fold-label{flex:none}
.ap-mail{border:1px solid var(--line);border-radius:10px;padding:.8rem .95rem;background:var(--bg)}
.ap-mail pre.body{margin:0;padding:0;border:0;background:none;font-family:inherit;font-size:.93rem;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;max-height:none;overflow:visible}
.ap-row .ap-mail pre.body{max-height:none;overflow:visible}
.ap-mail-more > summary{justify-content:flex-start;gap:.3rem;margin-top:.5rem;padding-top:.5rem;border-top:1px dashed var(--line);color:var(--muted);font-size:.85rem;font-weight:500}
.ap-mail-more > summary .fold-label{flex:none}
.ap-mail-more[open] > summary{order:2}
.ap-files{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:.4rem}
.ap-file{display:inline-flex;align-items:center;gap:.4rem;padding:.3rem .6rem;border:1px solid var(--line);border-radius:8px;background:var(--surface);font-size:.85rem;max-width:100%;overflow-wrap:anywhere}
.ap-file-icon{flex:none;display:inline-flex;color:var(--muted)}
.ap-file-icon svg{width:.9rem;height:.9rem}
.ap-files-note{margin:.35rem 0 0;font-size:.8rem}
.ap-state{display:flex;align-items:flex-start;gap:.6rem;margin:.75rem 0;padding:.6rem .85rem;border:1px solid var(--line);border-radius:10px;font-size:.9rem}
.ap-state p{margin:0}
.ap-state-icon{flex:none;display:inline-flex;margin-top:.15rem}
.ap-state-icon svg{width:1.05rem;height:1.05rem}
.ap-state-text{flex:1;min-width:0;overflow-wrap:anywhere}
.ap-state[data-tone="ok"]{background:var(--ok-bg);border-color:color-mix(in srgb,var(--ok) 30%,transparent)}
.ap-state[data-tone="ok"] .ap-state-icon{color:var(--ok)}
.ap-state[data-tone="error"]{background:var(--danger-bg);border-color:color-mix(in srgb,var(--danger) 30%,transparent)}
.ap-state[data-tone="error"] .ap-state-icon{color:var(--danger)}
.ap-state[data-tone="warn"]{background:var(--warn-bg);border-color:color-mix(in srgb,var(--warn) 30%,transparent)}
.ap-state[data-tone="warn"] .ap-state-icon{color:var(--warn)}
.ap-state[data-tone="info"]{background:var(--info-bg);border-color:color-mix(in srgb,var(--info) 30%,transparent)}
.ap-state[data-tone="info"] .ap-state-icon{color:var(--info)}
.ap-decide .ap-state{margin:0 0 .75rem}

.ap{max-width:76rem;container-type:inline-size;container-name:ap}
.ap-layout{display:grid;grid-template-columns:minmax(0,1fr) 20rem;grid-template-areas:"title side" "main side";gap:.85rem 1.25rem;align-items:start}
.ap-title{grid-area:title;font-size:1.25rem;line-height:1.4;margin:0;letter-spacing:-.02em;overflow-wrap:anywhere}
.ap-title mark{border-radius:6px;padding:0 .3rem}
.ap-main{grid-area:main;min-width:0;padding:1.1rem 1.4rem 1.3rem;border:1px solid var(--line);border-radius:14px;background:var(--bg);box-shadow:0 1px 2px rgb(0 0 0 / .04)}
.ap-content .ap-row{grid-template-columns:4.5rem minmax(0,1fr);padding:.5rem 0}
.ap-content .ap-row:first-of-type{border-top:0}
.ap-content .ap-mail{border:0;padding:.25rem 0 0;border-radius:0}
.ap-script{margin-top:1.2rem;padding-top:1rem;border-top:1px solid var(--line)}
.ap-script h2{font-size:1rem;margin:0 0 .4rem}
.ap-side{grid-area:side;position:sticky;top:1.25rem;max-height:calc(100vh - 2.5rem);overflow:auto;padding:1rem 1.1rem;border:1px solid var(--line);border-radius:14px;background:var(--bg);box-shadow:0 1px 2px rgb(0 0 0 / .04)}
.ap-status{display:flex;align-items:center;gap:.5rem;margin:0;font-size:.82rem}
.ap-side .reason{margin:.7rem 0 0;padding:0;border:0;font-size:.88rem;line-height:1.45;overflow-wrap:anywhere}
.ap-side .reason figcaption{display:inline;font-size:inherit;color:var(--muted)}
.ap-side .reason blockquote{display:inline;margin:0}
.ap-side .ap-state{margin:.75rem 0 0;font-size:.85rem}
.ap-decide{margin:.8rem 0 0;padding:0;border:0;border-radius:0;background:none;box-shadow:none}
.ap-side .ap-risk{font-size:.86rem;margin:0 0 .6rem}
.ap-check-hints{list-style:none;margin:0 0 .6rem;padding:0;display:grid;gap:.3rem;font-size:.84rem}
.ap-check-hints li{display:flex;align-items:baseline;gap:.45rem}
.ap-folds{display:flex;flex-wrap:wrap;align-items:flex-start;gap:0 1.25rem;margin-top:.55rem}
.ap-folds > details{flex:0 0 auto}
.ap-folds > details[open]{flex:1 1 100%;order:2}
.ap-folds > details > summary{justify-content:flex-start;gap:.25rem;padding:.35rem 0;color:var(--muted);font-size:.84rem;font-weight:500}
.ap-folds > details > summary:hover,.ap-folds > details[open] > summary{color:var(--text)}
.ap-folds > details > summary .fold-label{flex:none}
.ap-more{margin:0;border:0}
.ap-fold-body{padding:.35rem 0 .5rem;font-size:.85rem}
.ap-fold-body fieldset{margin:.25rem 0 0}
.ap-details .ap-meta{display:flex;flex-wrap:wrap;gap:.1rem .6rem;margin:0 0 .5rem}
.ap-sub{font-size:.8rem;font-weight:600;color:var(--muted);margin:.6rem 0 .35rem}
.ap-details dl.facts{grid-template-columns:auto minmax(0,1fr);gap:.25rem .75rem;font-size:.82rem}
.ap-details .ap-hints{margin:.75rem 0 0;padding-top:.6rem;border-top:1px solid var(--line)}
.ap-side-label{font-size:.8rem;font-weight:600;color:var(--muted);margin:0 0 .3rem}
.ap-hints-note{font-size:.78rem;margin:0 0 .45rem}
.ap-args{margin-top:.6rem;border-top:1px solid var(--line)}
.ap-args > summary{padding:.5rem 0;font-weight:600;font-size:.84rem}
.ap-args pre.args{font-size:.8rem}
@container ap (max-width:52rem){
  .ap-layout{grid-template-columns:minmax(0,1fr);grid-template-areas:"title" "side" "main";gap:.65rem}
  .ap-title{font-size:1.08rem;line-height:1.4}
  .ap-title mark{padding:0 .2rem}
  .ap-side{position:static;max-height:none;overflow:visible;padding:.85rem .95rem}
  .ap-main{padding:.9rem 1rem 1rem}
  .ap-content .ap-row{grid-template-columns:1fr;gap:.15rem}
}
/* A commit id is 40 characters with no spaces: let it wrap instead of running off a phone screen. */
.ap-sha{overflow-wrap:anywhere;word-break:break-all}
`;
