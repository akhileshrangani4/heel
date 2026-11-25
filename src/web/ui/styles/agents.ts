/** Styles for the agents, standing approvals and grants pages, appended to the shared stylesheet in theme.ts. */
export const AGENTS_CSS = `
.page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;margin:0 0 .5rem}
.page-head h1{margin-bottom:.25rem}
.page-head p{margin:0}
.page-head > .btn{flex:none;margin-top:.35rem}
.agents-section{margin:1.5rem 0}
.agents-section h2{margin:0 0 .25rem}
.how-fold{margin:.25rem 0 1rem;font-size:.88rem}
.how-fold > summary{display:inline-flex;align-items:center;gap:.25rem;color:var(--muted);width:fit-content;list-style:none}
.how-fold > summary::-webkit-details-marker{display:none}
.how-fold > summary:hover{color:var(--text)}
.how-fold .chev{width:.95rem;height:.95rem;transition:transform .15s}
.how-fold[open] > summary .chev{transform:rotate(180deg)}
.how-fold > p{margin:.4rem 0 0;max-width:46rem}
.dialog-form{margin:.5rem 0 0}
.dialog-status{margin:.25rem 0 0;padding:.55rem .7rem;border-radius:8px;background:var(--surface);color:var(--text);font-size:.85rem;overflow-wrap:anywhere}
.dialog-form.stack-form,.ui-dialog .grant-form{grid-template-columns:1fr}
.ui-dialog .stack-form .btn,.ui-dialog .grant-form .btn{grid-column:1;justify-self:stretch;margin-top:.5rem}
.ui-dialog .grant-form{display:grid;gap:.35rem}
.ui-dialog .grant-form label{margin-top:.35rem}
.ui-dialog select{width:100%}
.ui-dialog .ui-select{display:flex}
.ui-dialog .ui-select-trigger{height:auto;min-height:2.25rem;padding-block:.45rem;white-space:normal}
.ui-dialog .ui-select-value{overflow-wrap:anywhere}
.ui-dialog .ui-select-content{max-width:100%}
table.rows-table td{vertical-align:middle}
.cell-sub{display:block;color:var(--muted);font-size:.8rem;margin-top:.1rem;overflow-wrap:anywhere}
.cell-code{font-size:.82rem;overflow-wrap:anywhere}
.cell-sub time{white-space:nowrap}
.cell-actions{width:1%;white-space:nowrap;text-align:right}
.cell-actions form{display:inline;margin:0}
.agent-name{font-weight:600;color:var(--text);text-decoration:none;font-family:ui-monospace,"Geist Mono",SFMono-Regular,Menlo,Consolas,monospace;font-size:.9rem}
.agent-name:hover{text-decoration:underline}
.agents-table tr[data-revoked] .agent-name{color:var(--muted)}
.agents-empty-icon{background:var(--surface);color:var(--muted)}
.row-manage{position:relative;display:inline-block;text-align:left}
.row-manage > summary{list-style:none}
.row-manage > summary::-webkit-details-marker{display:none}
.row-manage-panel{position:absolute;right:0;top:calc(100% + .35rem);z-index:6;width:min(22rem,calc(100vw - 3rem));padding:1rem;border:1px solid var(--line);border-radius:12px;background:var(--bg);box-shadow:0 12px 32px -12px rgb(0 0 0 / .3);white-space:normal;display:grid;grid-template-columns:minmax(0,1fr);gap:.6rem}
.row-manage-panel form{display:grid;grid-template-columns:minmax(0,1fr);gap:.4rem}
.row-manage-panel code{min-width:0;overflow-wrap:anywhere}
.row-manage-panel .btn{height:auto!important;min-height:2.25rem;white-space:normal!important;overflow-wrap:anywhere}
.row-manage-panel h3{margin:.25rem 0 0;font-size:.88rem}
.row-manage-panel p{margin:0;font-size:.82rem}
.row-manage-panel .workdirs{list-style:none;margin:0;padding:0;display:grid;gap:.35rem}
.row-manage-panel .workdirs li{display:flex;align-items:center;justify-content:space-between;gap:.5rem}
.row-manage-panel .workdirs li > form{flex:none}
.table-scroll:has(.row-manage[open]){overflow:visible}
@media (max-width:36rem){
  .page-head{flex-direction:column;gap:.5rem}
  .page-head > .btn{margin-top:0}
  table.rows-table{min-width:0}
  table.rows-table thead{display:none}
  table.rows-table,table.rows-table tbody{display:block}
  table.rows-table tr{display:flex;flex-wrap:wrap;align-items:center;gap:.3rem .75rem;padding:.75rem .85rem}
  table.rows-table td{padding:0!important;border:0}
  table.rows-table td:first-child{flex:1 1 calc(100% - 5.5rem);min-width:0}
  table.rows-table td.cell-actions{order:1;width:auto}
  table.rows-table td:not(:first-child):not(.cell-actions){order:2;font-size:.82rem}
  table.rows-table td.cell-actions:empty{display:none}
}
/* Touch: at least a 44px hit area around small controls, without moving them. */
@media (pointer:coarse){
  .row-manage > summary,.how-fold > summary,.cell-actions .btn,.agent-name{position:relative}
  .row-manage > summary::after,.how-fold > summary::after,.cell-actions .btn::after,.agent-name::after{content:"";position:absolute;top:50%;left:50%;width:max(100%,44px);height:max(100%,44px);transform:translate(-50%,-50%)}
}
`;
