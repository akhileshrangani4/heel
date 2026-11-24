/** Styles for the activity page, appended to the shared stylesheet in theme.ts. */
export const ACTIVITY_CSS = `
.act-toolbar{display:flex;align-items:flex-start;justify-content:space-between;gap:.5rem;margin:1rem 0}
.act-filter-bar{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem}
.act-filter{position:relative}
.act-filter > summary{list-style:none}
.act-filter > summary::-webkit-details-marker{display:none}
.act-filter[open] > summary{background:var(--surface)}
.act-filter-count{display:inline-block;min-width:1.15rem;padding:0 .3rem;border-radius:999px;background:var(--accent);color:var(--accent-text);font-size:.68rem;font-weight:700;line-height:1.15rem;text-align:center}
.act-filter-panel{position:absolute;left:0;top:calc(100% + .4rem);z-index:20;width:min(40rem,calc(100vw - 2rem));padding:.5rem;border:1px solid var(--line);border-radius:12px;background:var(--bg);box-shadow:0 12px 32px -12px rgb(0 0 0 / .3)}
.act-filter-groups{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.25rem}
.act-filter-group{margin:0;padding:0;border:0;min-width:0;max-height:20rem;overflow-y:auto}
.act-filter-group legend{padding:.35rem .5rem .25rem;color:var(--muted);font-size:.75rem;font-weight:600}
.act-filter-group input:not([type="radio"]){margin:.15rem .25rem}
.act-option{position:relative;display:flex;align-items:center;justify-content:space-between;gap:.5rem;padding:.4rem .5rem;border-radius:6px;font-size:.875rem;cursor:pointer;overflow-wrap:anywhere}
.act-option:hover{background:var(--surface)}
.act-option input{position:absolute;opacity:0;pointer-events:none}
.act-option:has(input:focus-visible){outline:2px solid var(--focus);outline-offset:-2px}
.act-option-check{flex:none;width:1rem;height:1rem;visibility:hidden}
.act-option:has(input:checked){font-weight:500;background:color-mix(in srgb,var(--surface) 60%,transparent)}
.act-option:has(input:checked) .act-option-check{visibility:visible}
.act-filter-actions{display:flex;justify-content:flex-end;gap:.5rem;margin-top:.4rem;padding-top:.5rem;border-top:1px solid var(--line)}
.act-chip-filter{display:inline-flex;align-items:center;gap:.3rem;height:2rem;padding:0 .3rem 0 .65rem;border:1px solid var(--line);border-radius:999px;background:var(--bg);font-size:.82rem;color:var(--muted)}
.act-chip-filter strong{color:var(--text);font-weight:500}
.act-chip-filter a{display:inline-flex;align-items:center;justify-content:center;width:1.4rem;height:1.4rem;border-radius:999px;color:var(--muted)}
.act-chip-filter a:hover{background:var(--surface);color:var(--text)}
.act-chip-filter svg{width:.85rem;height:.85rem}
@media (max-width:36rem){
  .act-filter-panel{position:fixed;left:calc(.75rem + var(--safe-l));right:calc(.75rem + var(--safe-r));top:auto;bottom:calc(5.4rem + var(--safe-b));width:auto;max-height:70dvh;overflow-y:auto}
  .act-filter-groups{grid-template-columns:1fr}
  .act-filter-group{max-height:none}
  .act-filter-panel{padding-bottom:0}
  .act-filter-actions{position:sticky;bottom:0;margin:0 -.5rem;padding:.6rem .5rem;background:var(--bg)}
}
.audit-export{position:relative;flex:none}
.audit-export > summary{list-style:none}
.audit-export > summary::-webkit-details-marker{display:none}
.audit-export-panel{position:absolute;right:0;top:calc(100% + .4rem);z-index:5;width:min(22rem,calc(100vw - 2rem));padding:1rem;border:1px solid var(--line);border-radius:12px;background:var(--bg);box-shadow:0 12px 32px -12px rgb(0 0 0 / .3)}
.audit-export-panel p{margin:0 0 .6rem;font-size:.85rem}
.audit-export-title{font-weight:600;color:var(--text)}
.act-pages{display:flex;align-items:center;justify-content:space-between;gap:.75rem;flex-wrap:wrap;margin:.75rem 0 1.5rem;font-size:.85rem}
.act-pages-buttons{display:flex;gap:.5rem}
.act-pages [aria-disabled="true"]{opacity:.45;pointer-events:none}
.table-scroll:has(> table[hidden]){display:none}
table.act-table td{vertical-align:top}
table.act-table tr.day{border-bottom:0}
table.act-table tr.day:hover{background:none}
table.act-table tr.day th{padding:1rem .85rem .35rem;color:var(--text);font-size:.88rem;font-weight:600}
table.act-table tbody tr.day:first-child th{padding-top:.6rem}
.day-count{display:inline-block;min-width:1.35rem;margin-left:.35rem;padding:0 .4rem;border-radius:999px;background:var(--surface);box-shadow:inset 0 0 0 1px var(--line);color:var(--muted);font-size:.72rem;font-weight:500;line-height:1.35rem;text-align:center}
.act-kind{width:8.5rem;white-space:nowrap}
.act-watch{display:block;font-size:.75rem;margin-top:.2rem}
.act-sentence{margin:0;font-weight:500;overflow-wrap:anywhere}
.act-meta{display:flex;flex-wrap:wrap;align-items:center;gap:.25rem .75rem;margin:.3rem 0 0;font-size:.85rem}
.act-chip{display:inline-block;padding:0 .4rem;border-radius:6px;background:var(--surface);box-shadow:inset 0 0 0 1px var(--line);font-size:.8rem}
.act-reason{flex-basis:100%}
.act-details{margin-top:.35rem;font-size:.85rem}
.act-details summary{display:inline-flex;align-items:center;gap:.25rem;color:var(--muted);width:fit-content;list-style:none}
.act-details summary::-webkit-details-marker{display:none}
.act-details summary:hover{color:var(--text)}
.act-details .chev{width:.9rem;height:.9rem;transition:transform .15s}
.act-details[open] > summary .chev{transform:rotate(180deg)}
.act-details dl.facts{margin:.5rem 0 .25rem;grid-template-columns:minmax(5rem,max-content) 1fr}
.act-when{width:4.5rem;white-space:nowrap;color:var(--muted);font-size:.85rem;text-align:right;font-variant-numeric:tabular-nums}
@media (max-width:36rem){
  table.act-table{min-width:0}
  table.act-table,table.act-table tbody{display:block}
  table.act-table tr{display:grid;grid-template-columns:auto 1fr;gap:.25rem .6rem;padding:.65rem .85rem;border-bottom:1px solid var(--line)}
  table.act-table tr.day{display:block;padding:0}
  table.act-table tr.day th{display:block}
  table.act-table tr > td{padding:0;border:0}
  table.act-table .act-what{grid-column:1 / -1;grid-row:2}
  table.act-table .act-when{text-align:right;width:auto}
  table.act-table .act-kind{width:auto}
}
`;
