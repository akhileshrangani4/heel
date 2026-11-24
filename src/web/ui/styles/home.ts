/** Styles for the home page, appended to the shared stylesheet in theme.ts. */
export const HOME_CSS = `
.home > h1{margin-bottom:1rem}
.home h2{font-size:1rem;margin:0}
.home-tiles{list-style:none;margin:0 0 1rem;padding:0;display:grid;gap:.75rem;grid-template-columns:repeat(4,minmax(0,1fr))}
.home-tiles > li{display:flex;min-width:0}
.home-tile{flex:1;min-width:0;display:flex;flex-direction:column;gap:.3rem;padding:1rem 1.1rem;border:1px solid var(--line);border-radius:14px;background:var(--bg);color:var(--text);text-decoration:none;box-shadow:0 1px 2px rgb(0 0 0 / .04);transition:border-color .15s,box-shadow .15s,transform .15s}
.home-tile:hover{border-color:var(--text);box-shadow:0 8px 24px -12px rgb(0 0 0 / .35);transform:translateY(-1px)}
.home-tile:focus-visible{outline-offset:2px}
.home-tile[data-alert="warn"]{border-color:color-mix(in srgb,var(--warn) 55%,transparent)}
.home-tile[data-alert="error"]{border-color:color-mix(in srgb,var(--danger) 55%,transparent)}
.home-tile[data-alert="warn"]:hover{border-color:var(--warn)}
.home-tile[data-alert="error"]:hover{border-color:var(--danger)}
.home-tile-title{color:var(--muted);font-size:.85rem;font-weight:500}
.home-tile-big{font-size:1.9rem;line-height:1.15;font-weight:600;letter-spacing:-.04em}
.home-tile-line{color:var(--muted);font-size:.8rem;overflow-wrap:anywhere}
.home-tile[data-alert="warn"] .home-tile-line{color:var(--warn);font-weight:600}
.home-tile[data-alert="error"] .home-tile-line{color:var(--danger);font-weight:600}
@media (prefers-reduced-motion:reduce){.home-tile{transition:none}.home-tile:hover{transform:none}}
@media (max-width:56rem){.home-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:36rem){.home-tiles{gap:.5rem}.home-tile{padding:.75rem .8rem}.home-tile-big{font-size:1.6rem}}
.home-wait{margin:0 0 1rem;border-color:color-mix(in srgb,var(--warn) 45%,transparent)}
.home-wait h2{display:flex;align-items:center;gap:.5rem}
.home-wait-list{list-style:none;margin:.5rem -.5rem 0;padding:0}
.home-wait-list li + li{border-top:1px solid var(--line)}
.home-wait-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:.75rem;padding:.6rem .5rem;border-radius:10px;color:var(--text);text-decoration:none;transition:background-color .15s}
.home-wait-row:hover,.home-wait-row:focus-visible{background:var(--surface)}
.home-wait-row:focus-visible{outline-offset:-2px}
.home-wait-row .svc-logo{width:2rem;height:2rem}
.home-wait-row .svc-letter svg{width:1rem;height:1rem}
.home-wait-body{display:flex;flex-direction:column;min-width:0}
.home-wait-text{font-weight:600;font-size:.93rem;line-height:1.4;overflow-wrap:anywhere}
.home-wait-text mark{border-radius:5px;padding:0 .2rem}
.home-wait-when{font-size:.8rem}
.home-wait-soon{color:var(--warn);font-weight:600}
.home-setup{margin:0 0 1rem}
.home-setup-head,.home-week-head{display:flex;justify-content:space-between;align-items:center;gap:1rem}
.home-setup-progress{display:flex;align-items:center;gap:.6rem;font-size:.85rem}
.home-setup-bar{display:block;width:6rem;height:6px;border-radius:999px;background:var(--surface);overflow:hidden}
.home-setup-bar > span{display:block;height:100%;background:var(--ok);border-radius:999px}
.home-steps{list-style:none;margin:.75rem 0 0;padding:0;display:grid;gap:.4rem}
.home-steps a{display:flex;align-items:center;gap:.75rem;padding:.7rem .8rem;border:1px solid var(--line);border-radius:10px;color:var(--text);text-decoration:none;transition:background-color .15s}
.home-steps a:hover{background:var(--surface)}
.home-step-mark{flex:none;display:inline-grid;place-items:center;width:1.35rem;height:1.35rem;border-radius:999px;box-shadow:inset 0 0 0 1.5px var(--border)}
.home-step-mark svg{width:.8rem;height:.8rem}
.home-steps li[data-done="yes"] .home-step-mark{background:var(--ok);color:var(--bg);box-shadow:none}
.home-step-text{flex:1;display:flex;flex-direction:column;min-width:0}
.home-step-label{font-weight:600;font-size:.93rem}
.home-steps li[data-done="yes"] .home-step-label{color:var(--muted);font-weight:500}
.home-step-line{color:var(--muted);font-size:.82rem}
.home-step-go{flex:none;display:inline-flex;color:var(--muted)}
.home-step-go svg{width:1rem;height:1rem}
.home-split{display:grid;gap:.75rem;grid-template-columns:repeat(auto-fit,minmax(18rem,1fr));align-items:start}
.home-split .card{margin:0}
.home-week-total{font-size:1.5rem;letter-spacing:-.03em}
.home-spark{display:block;width:100%;height:4rem;margin:.75rem 0 .25rem}
.home-spark rect{fill:var(--accent)}
.home-spark rect.empty{fill:var(--line)}
.home-spark-days{display:grid;grid-template-columns:repeat(7,1fr);font-size:.72rem;text-align:center}
.home-totals{list-style:none;margin:.75rem 0 0;padding:.75rem 0 0;border-top:1px solid var(--line);display:flex;flex-wrap:wrap;gap:.5rem 1.25rem;font-weight:600}
.home-empty{display:flex;flex-direction:column;align-items:center;text-align:center;gap:.3rem;padding:1.5rem .5rem .75rem}
.home-empty p{margin:0;font-size:.88rem}
.home-empty-icon{display:inline-grid;place-items:center;width:2.4rem;height:2.4rem;border-radius:10px;background:var(--surface);color:var(--muted);margin-bottom:.25rem}
.home-empty-icon svg{width:1.15rem;height:1.15rem}
.home-empty-title{font-weight:600;color:var(--text)}
.home-empty .btn{margin-top:.6rem}
.home-more{color:var(--muted);font-size:.85rem;text-decoration:none}
.home-more:hover{color:var(--text)}
.home-recent-list{list-style:none;margin:.5rem 0 0;padding:0}
.home-recent-list li{display:flex;justify-content:space-between;align-items:center;gap:.4rem .75rem;flex-wrap:wrap;padding:.55rem 0;border-top:1px solid var(--line)}
.home-recent-list li:first-child{border-top:0}
.home-recent-text{overflow-wrap:anywhere;min-width:0}
.home-recent-meta{display:flex;align-items:center;gap:.5rem;font-size:.82rem;white-space:nowrap}
`;
