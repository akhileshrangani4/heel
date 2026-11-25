/** Styles for the settings pages (Pause, Devices, People, Modes), appended to the shared stylesheet in theme.ts. */
export const SETTINGS_CSS = `
.ui-switch{display:inline-flex;align-items:center;gap:.55rem;flex:none;padding:.25rem .1rem;border:0;background:none;color:var(--text);font:inherit;font-size:.85rem;cursor:pointer;border-radius:8px}
.ui-switch:disabled,.ui-switch[aria-disabled="true"]{cursor:not-allowed;opacity:.55}
.ui-switch-track{position:relative;display:inline-block;width:2.25rem;height:1.25rem;border-radius:999px;background:var(--border);transition:background-color .15s;flex:none}
.ui-switch-track[data-on="true"]{background:var(--accent)}
.ui-switch-thumb{position:absolute;top:2px;left:2px;width:calc(1.25rem - 4px);height:calc(1.25rem - 4px);border-radius:999px;background:var(--bg);box-shadow:0 1px 2px rgb(0 0 0 / .25);transition:transform .15s}
.ui-switch-track[data-on="true"] .ui-switch-thumb{transform:translateX(1rem)}
.ui-switch-word{min-width:3.6rem;text-align:left;color:var(--muted)}
.ui-switch[aria-checked="true"] .ui-switch-word{color:var(--text)}
.ui-switch:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
@media (prefers-reduced-motion:reduce){.ui-switch-track,.ui-switch-thumb{transition:none}}
/* Touch: at least a 44px hit area around small controls, without moving them. */
@media (pointer:coarse){
  .ui-switch,.seg-item,.set-menu > summary,.set-fold > summary,.pause-everything .btn,.settings-row-foot .btn{position:relative}
  .ui-switch::after,.seg-item::after,.set-menu > summary::after,.set-fold > summary::after,.pause-everything .btn::after,.settings-row-foot .btn::after{content:"";position:absolute;top:50%;left:50%;width:max(100%,44px);height:max(100%,44px);transform:translate(-50%,-50%)}
}
.pause-rule{margin:0 0 1rem}
.pause-everything{display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin:0 0 1rem}
.pause-everything.is-paused{border-color:color-mix(in srgb,var(--warn) 45%,transparent);background:var(--warn-bg)}
.pause-rows{list-style:none;margin:0 0 1rem;padding:0;border:1px solid var(--line);border-radius:14px;background:var(--bg);overflow:hidden;box-shadow:0 1px 2px rgb(0 0 0 / .04)}
.pause-group-label{padding:.65rem 1rem .3rem;color:var(--muted);font-size:.78rem;font-weight:600;background:color-mix(in srgb,var(--surface) 50%,transparent)}
.pause-row{display:flex;align-items:center;justify-content:space-between;gap:.5rem 1rem;padding:.7rem 1rem;border-top:1px solid var(--line)}
.pause-row-text{display:flex;flex-direction:column;min-width:0}
.pause-row-text .muted{font-size:.82rem}
.pause-row-control{display:inline-flex;align-items:center;gap:.6rem;flex-wrap:wrap}
.pause-row-note{font-size:.8rem}
.pause-row-text time{white-space:nowrap}
.settings-card{margin:0 0 1rem;padding:1rem 1.15rem;border:1px solid var(--line);border-radius:14px;background:var(--bg);box-shadow:0 1px 2px rgb(0 0 0 / .04)}
.settings-row{display:flex;align-items:center;justify-content:space-between;gap:.75rem 1.5rem}
.settings-row-text{min-width:0;flex:1}
.settings-row-title{font-size:.98rem;margin:0}
.settings-row-text p{margin:.2rem 0 0;font-size:.86rem}
.settings-row .btn{flex:none}
.settings-row-status{margin:.5rem 0 0;font-size:.85rem}
.settings-row-foot{display:flex;align-items:center;justify-content:space-between;gap:.25rem 1rem;flex-wrap:wrap;margin-top:.75rem;padding-top:.65rem;border-top:1px solid var(--line);font-size:.84rem}
.settings-row-foot form{margin:0}
.settings-card .notice{margin:.75rem 0 0}
@media (max-width:36rem){.settings-row{flex-direction:column;align-items:flex-start}}
.set-head{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;flex-wrap:wrap}
.set-head > div{min-width:0;flex:1}
.set-head .btn{margin-top:.35rem}
.person-table td,.person-table th{vertical-align:middle!important}
table.person-table .person-name,table.person-table .person-meta{white-space:normal!important;overflow-wrap:anywhere}
.person-meta{font-size:.85rem}
.person-manage{width:3rem;text-align:right}
.set-menu{position:relative;display:inline-block}
.set-menu > summary{list-style:none}
.set-menu > summary::-webkit-details-marker{display:none}
.set-menu-panel{position:absolute;right:0;top:calc(100% + .4rem);z-index:5;width:min(24rem,calc(100vw - 3rem));padding:1rem;border:1px solid var(--line);border-radius:12px;background:var(--bg);box-shadow:0 12px 32px -12px rgb(0 0 0 / .3);text-align:left;white-space:normal}
.set-menu-title{margin:0 0 .5rem;font-weight:600}
.set-menu-panel .stack-form,.set-menu-panel .form{margin:.5rem 0 0}
.table-scroll:has(.set-menu[open]){overflow:visible}
@media (max-width:36rem){
  table.person-table{min-width:0}
  table.person-table thead{display:none}
  table.person-table,table.person-table tbody{display:block}
  table.person-table tr{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:.2rem .75rem;padding:.7rem .85rem;border-bottom:1px solid var(--line)}
  table.person-table tr > *{padding:0!important;border:0;height:auto!important}
  table.person-table .person-role{grid-column:1}
  table.person-table .person-meta{grid-column:1 / -1}
  table.person-table .person-manage{grid-row:1;grid-column:2}
}
.set-fold{margin:.25rem 0 1rem;font-size:.9rem}
.set-fold > summary{display:inline-flex;align-items:center;gap:.3rem;color:var(--muted);list-style:none;width:fit-content}
.set-fold > summary::-webkit-details-marker{display:none}
.set-fold > summary:hover{color:var(--text)}
.set-fold .chev{width:.95rem;height:.95rem;transition:transform .15s}
.set-fold[open] > summary .chev{transform:rotate(180deg)}
.set-fold > :not(summary){margin-top:.5rem}
.seg{display:inline-flex;align-items:center;gap:2px;padding:3px;border-radius:9px;background:var(--surface);box-shadow:inset 0 0 0 1px var(--line)}
.seg form{display:inline-flex;margin:0}
.seg-item{display:inline-flex;align-items:center;padding:.25rem .8rem;border:0;border-radius:7px;background:none;color:var(--muted);font:inherit;font-size:.85rem;line-height:1.4;white-space:nowrap;cursor:pointer}
button.seg-item:hover{color:var(--text);background:color-mix(in srgb,var(--bg) 60%,transparent)}
.seg-item[aria-pressed="true"]{background:var(--bg);color:var(--text);font-weight:600;box-shadow:0 1px 2px rgb(0 0 0 / .1);cursor:default}
.seg-item[aria-disabled="true"]{opacity:.5;cursor:not-allowed}
.seg-note{display:block;margin-top:.3rem;font-size:.8rem}
.mode-switch{white-space:nowrap}
.mode-means{display:block;margin-top:.3rem;font-size:.84rem}
@media (max-width:36rem){
  table.modes-table{min-width:0}
  table.modes-table thead{display:none}
  table.modes-table,table.modes-table tbody{display:block}
  table.modes-table tr{display:grid;grid-template-columns:minmax(0,1fr);gap:.5rem;padding:.75rem .85rem;border-bottom:1px solid var(--line)}
  table.modes-table tr:last-child{border-bottom:0}
  table.modes-table tr > *{padding:0!important;border:0;height:auto!important;white-space:normal!important;overflow-wrap:anywhere}
  table.modes-table .badge{white-space:normal}
}
`;
