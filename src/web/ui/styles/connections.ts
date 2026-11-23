/** Styles for the connections page, appended to the shared stylesheet in theme.ts. */
export const CONNECTIONS_CSS = `
.svc-logo{display:inline-grid;place-items:center;flex:none;width:2.25rem;height:2.25rem;border-radius:10px;background:var(--bg);box-shadow:inset 0 0 0 1px var(--line);color:var(--text)}
.svc-logo svg{width:1.25rem;height:1.25rem;display:block}
.svc-letter{background:var(--surface);color:var(--muted);font-weight:600;font-size:.95rem}
.conn-page-head{display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;flex-wrap:wrap;margin-bottom:.5rem}
.conn-page-head h1{margin-bottom:.25rem}
.conn-page-head p{margin:0;max-width:40rem}
.conn-page-head .btn{flex:none}
.conn-table{margin:1rem 0 1.5rem;background:var(--bg);border:1px solid var(--line);border-radius:14px}
.conn-table-head{margin:0;padding:.6rem 1rem;background:var(--surface);border-bottom:1px solid var(--line);border-radius:14px 14px 0 0;color:var(--muted);font-size:.82rem;font-weight:600}
.conn-rows{list-style:none;margin:0;padding:0}
.conn-rows > .conn{display:block;margin:0;padding:.8rem 1rem;border-top:1px solid var(--line)}
.conn-rows > .conn:first-child{border-top:0}
.conn-main{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto;align-items:center;gap:.4rem .9rem}
.conn-icon{display:inline-flex}
.conn-id{min-width:0}
.conn-rows .conn-name{font-size:.95rem;margin:0;overflow-wrap:anywhere}
.conn-rows .conn-kind{margin:0;font-size:.83rem}
.conn-rows .conn-hint{margin:.3rem 0 0;padding:0;border:0;font-size:.85rem}
.conn-status{justify-self:end}
.conn-actions{display:flex;align-items:center;gap:.4rem;justify-self:end}
.conn-actions .conn-step{border:0;padding:0}
.conn-actions form{display:inline;margin:0}
.conn-manage{position:relative}
.conn-manage > summary{list-style:none}
.conn-manage > summary::-webkit-details-marker{display:none}
.conn-manage[open] > summary{background:var(--surface)}
.conn-manage-panel{position:absolute;right:0;top:calc(100% + .4rem);z-index:6;width:min(26rem,calc(100vw - 2rem));max-height:min(32rem,70vh);overflow:auto;padding:1rem;border:1px solid var(--line);border-radius:12px;background:var(--bg);box-shadow:0 12px 32px -12px rgb(0 0 0 / .3);font-size:.9rem;text-align:left}
.conn-manage-title{margin:0 0 .5rem;font-weight:600}
.conn-manage-panel h3{font-size:.92rem;margin:1rem 0 .4rem}
.conn-empty-icon{background:var(--surface);color:var(--muted)}
.conn-empty .btn{margin-top:.6rem}
.connect-form{display:grid;gap:.9rem}
.svc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(12.5rem,1fr));gap:.5rem;margin:0;padding:0;border:0}
.svc-tile{position:relative;display:flex;align-items:center;gap:.7rem;padding:.65rem .75rem;border:1px solid var(--line);border-radius:10px;background:var(--bg);cursor:pointer;transition:border-color .15s,background-color .15s}
.svc-tile:hover{background:var(--surface)}
.svc-tile:has(.svc-radio:checked){border-color:var(--text);box-shadow:0 0 0 1px var(--text)}
.svc-tile:has(.svc-radio:focus-visible){outline:3px solid var(--focus);outline-offset:2px}
.svc-radio{position:absolute;opacity:0;width:1px;height:1px;margin:0}
.svc-tile-text{display:flex;flex-direction:column;min-width:0}
.svc-tile-name{font-weight:600;font-size:.9rem}
.svc-tile-line{color:var(--muted);font-size:.8rem}
.connect-fields{display:grid;gap:.75rem}
.connect-field{display:grid;gap:.3rem}
.connect-field label{font-weight:500;font-size:.88rem}
.connect-field p,.connect-fields > p{margin:0;font-size:.82rem}
.connect-fields .btn{justify-self:start}
.connect-status{margin:0;font-size:.85rem;color:var(--muted)}
.connect-pick{margin:0;font-size:.85rem}
@supports selector(:has(*)){
  .connect-form:not(:has(.svc-radio:checked)) .connect-fields{display:none}
  .connect-form:has(.svc-radio:checked) .connect-pick{display:none}
  .connect-form [data-for]{display:none}
  .connect-form:has(.svc-radio[data-need="key"]:checked) [data-for="key"],
  .connect-form:has(.svc-radio[data-need="mcp"]:checked) [data-for="mcp"],
  .connect-form:has(.svc-radio[data-need="signin"]:checked) [data-for="signin"]{display:grid}
}
.connect-cli{margin-top:1rem;border-top:1px solid var(--line);padding-top:.75rem;font-size:.88rem}
.connect-cli > summary{display:flex;align-items:center;justify-content:space-between;list-style:none;font-weight:500}
.connect-cli > summary::-webkit-details-marker{display:none}
.connect-cli .chev{width:1rem;height:1rem;color:var(--muted);transition:transform .15s}
.connect-cli[open] > summary .chev{transform:rotate(180deg)}
.connect-cli pre.args{margin-top:.5rem}
.conn-add{scroll-margin-top:1rem}
@media (max-width:36rem){
  .conn-main{grid-template-columns:auto minmax(0,1fr);align-items:start}
  .conn-status{grid-column:2;grid-row:2;justify-self:start}
  .conn-actions{grid-column:2;grid-row:3;justify-self:start}
  .conn-actions:empty{display:none}
  .conn-manage-panel{right:auto;left:0}
  .conn-page-head .btn{width:100%}
  .svc-grid{grid-template-columns:1fr}
}
`;
