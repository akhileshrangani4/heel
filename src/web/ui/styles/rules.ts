/** Styles for the Rules and Rule history pages, appended to the shared stylesheet in theme.ts. */
export const RULES_CSS = `
.card.preview > h2:first-child{margin-top:0}
.rules-lede{margin:.25rem 0 0}
.notice .problems{list-style:none;margin:.5rem 0 0;padding:0;display:grid;grid-template-columns:minmax(0,max-content) minmax(0,1fr);gap:.35rem 1rem;align-items:baseline;font-size:.88rem}
.notice .problems li{display:contents}
.problem-where{font-size:.8rem;color:var(--muted);overflow-wrap:anywhere}
.problem-what{overflow-wrap:anywhere}
.rules-empty-icon{background:var(--surface);color:var(--muted)}
.rules-empty{padding:1.75rem 1rem;border:1px dashed var(--line);border-radius:14px;margin:.5rem 0 1.25rem}
@media (max-width:36rem){.notice .problems{grid-template-columns:1fr;gap:.1rem}.notice .problem-what{margin-bottom:.35rem}}
.rules-file{margin:.2rem 0 1rem;font-size:.85rem}
.rule-list{list-style:none;margin:.5rem 0 1.25rem;padding:0;border:1px solid var(--line);border-radius:14px;background:var(--bg);box-shadow:0 1px 2px rgb(0 0 0 / .04)}
.rule-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:.25rem .9rem;padding:.75rem 1rem}
.rule-row + .rule-row{border-top:1px solid var(--line)}
.rule-n{display:inline-grid;place-items:center;width:1.6rem;height:1.6rem;border-radius:999px;background:var(--surface);color:var(--muted);font-size:.78rem;font-weight:600;font-variant-numeric:tabular-nums}
.rule-text{min-width:0}
.rule-words{margin:0;font-weight:600;font-size:.93rem;overflow-wrap:anywhere}
.rule-name{margin:.1rem 0 0;font-size:.78rem;color:var(--muted)}
.rule-actions{display:flex;align-items:center;gap:.35rem;margin:0}
.rule-remove{color:var(--danger)}
.rule-remove:hover{color:var(--danger);background:var(--danger-bg)}
@media (max-width:36rem){
  .rule-row{grid-template-columns:auto minmax(0,1fr);align-items:start}
  .rule-actions{grid-column:2}
}
.fold > summary{display:flex;align-items:center;justify-content:space-between;gap:.5rem;list-style:none;cursor:pointer;font-weight:500;padding:.6rem 0;border-top:1px solid var(--line)}
.fold > summary::-webkit-details-marker{display:none}
.fold .chev{flex:none;width:1rem;height:1rem;color:var(--muted);transition:transform .15s}
.fold[open] > summary .chev{transform:rotate(180deg)}
.rules-yaml{margin-top:1rem}
.rules-yaml > summary{border-bottom:1px solid var(--line)}
.rules-yaml[open] > summary{border-bottom:0}
.rules-diff{margin:1rem 0 .5rem}
.rules-diff-head{display:flex;justify-content:space-between;align-items:center;gap:1rem;margin:0 0 .4rem;font-size:.85rem;font-weight:600}
.rules-diff-count{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-weight:600}
.rules-diff-count .add{color:var(--ok)}
.rules-diff-count .remove{color:var(--danger)}
.diff li[data-op="gap"]{color:var(--muted);background:var(--surface);text-align:center}
.timeline{list-style:none;margin:1rem 0;padding:0;position:relative}
.timeline::before{content:"";position:absolute;left:.45rem;top:.4rem;bottom:.4rem;width:2px;background:var(--line);border-radius:2px}
.timeline-item{position:relative;display:grid;grid-template-columns:1rem minmax(0,1fr);gap:.9rem;padding:0 0 1.1rem}
.timeline-dot{position:relative;z-index:1;width:.95rem;height:.95rem;margin-top:.3rem;border-radius:999px;background:var(--ok);box-shadow:0 0 0 3px var(--page)}
.timeline-item[data-source="outside"] .timeline-dot{background:var(--warn)}
.timeline-item[data-source="web"] .timeline-dot{background:var(--info)}
.timeline-body{min-width:0}
.timeline-head{display:flex;flex-wrap:wrap;align-items:center;gap:.25rem .6rem;margin:0;font-size:.88rem}
.timeline-who{margin:.3rem 0 0}
.timeline-body .fold > summary{border-top:0;padding:.35rem 0;font-size:.88rem;color:var(--muted);justify-content:flex-start}
/* Touch: at least a 44px hit area around small controls, without moving them. */
@media (pointer:coarse){
  .rule-remove,.fold > summary{position:relative}
  .rule-remove::after,.fold > summary::after{content:"";position:absolute;top:50%;left:50%;width:max(100%,44px);height:max(100%,44px);transform:translate(-50%,-50%)}
}
`;
