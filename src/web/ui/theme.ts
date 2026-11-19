/**
 * The human plane's stylesheet. One palette per theme, both chosen for WCAG
 * AA contrast on their own background; the light/dark switch follows the
 * operating system unless the page sets `data-theme`. Status is always also
 * spelled out in text, never carried by colour alone.
 */

/**
 * Light: a warm off-white page with white cards, near-black ink, and status
 * colours on soft tints (roadmap 1.11). `bg` is a card's background; `page`
 * is behind the cards. `line` is a quiet divider; `border` outlines inputs
 * and must stay visible (3:1).
 */
const LIGHT = {
  page: "#f6f6f4",
  bg: "#ffffff",
  surface: "#f2f2f0",
  text: "#18181b",
  muted: "#5c5c63",
  border: "#8e8e96",
  line: "#e6e6e3",
  accent: "#18181b",
  "accent-text": "#ffffff",
  link: "#1d4fa8",
  danger: "#b91c1c",
  "danger-text": "#ffffff",
  ok: "#047857",
  warn: "#92400e",
  info: "#1d4fa8",
  "ok-bg": "#e6f4ee",
  "warn-bg": "#fef3c7",
  "danger-bg": "#fdecec",
  "info-bg": "#e8effb",
  "banner-bg": "#fef3c7",
  "banner-text": "#713f12",
  "add-bg": "#e3f4e7",
  "remove-bg": "#fbe5e3",
  focus: "#0b57d0",
} as const;

/** Every theme defines every colour the stylesheet uses. */
type Palette = Readonly<Record<keyof typeof LIGHT, string>>;

const DARK: Palette = {
  page: "#0f0f10",
  bg: "#18181a",
  surface: "#202023",
  text: "#f4f4f5",
  muted: "#a1a1aa",
  border: "#6b6b74",
  line: "#2a2a2e",
  accent: "#f4f4f5",
  "accent-text": "#18181b",
  link: "#8ab4f8",
  danger: "#f87171",
  "danger-text": "#1a0505",
  ok: "#34d399",
  warn: "#fbbf24",
  info: "#8ab4f8",
  "ok-bg": "#0f2a20",
  "warn-bg": "#2e2208",
  "danger-bg": "#2d1212",
  "info-bg": "#14213a",
  "banner-bg": "#2e2208",
  "banner-text": "#fde68a",
  "add-bg": "#13321c",
  "remove-bg": "#3d1714",
  focus: "#ffd166",
};

function variables(palette: Palette): string {
  return Object.entries(palette)
    .map(([name, value]) => `--${name}:${value};`)
    .join("");
}

const RULES = `
*,*::before,*::after{box-sizing:border-box}
html{color-scheme:light dark}
body{margin:0;background:var(--page);color:var(--text);font:15px/1.55 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--link);text-underline-offset:.2em}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
.skip{position:absolute;left:-9999px;top:0;padding:.5rem 1rem;background:var(--bg)}
.skip:focus{left:1rem;top:1rem;z-index:10}
.site{display:flex;flex-wrap:wrap;gap:.75rem 2rem;align-items:center;max-width:72rem;margin:0 auto;padding:1rem 1.5rem .25rem}
.site .brand{font-weight:700;font-size:1.1rem;letter-spacing:-.01em;color:var(--text);text-decoration:none}
.site nav{max-width:100%}
.site nav ul{display:flex;flex-wrap:wrap;gap:.25rem 1rem;list-style:none;margin:0;padding:0}
.site nav a{text-decoration:none;padding:.3rem .55rem;border-radius:8px;white-space:nowrap;display:inline-block;color:var(--muted);font-size:.93rem}
.site nav a:hover{color:var(--text);background:var(--surface)}
.site nav a[aria-current="page"]{color:var(--text);font-weight:600;background:var(--bg);box-shadow:inset 0 0 0 1px var(--line)}
.site .who{margin-left:auto;color:var(--muted);font-size:.88rem}
main{max-width:72rem;margin:0 auto;padding:1.5rem}
h1{font-size:1.55rem;line-height:1.3;letter-spacing:-.015em;margin:0 0 .5rem}
h2{font-size:1.2rem;margin:1.5rem 0 .5rem}
h3{font-size:1rem;margin:1rem 0 .5rem}
p{margin:.5rem 0}
.muted{color:var(--muted)}
.banner{padding:.7rem 1.5rem;background:var(--banner-bg);color:var(--banner-text);font-weight:600;text-align:center}
.notice{border:1px solid var(--line);border-left-width:4px;padding:.75rem 1rem;margin:1rem 0;background:var(--bg);border-radius:10px}
.notice[data-tone="error"]{border-left-color:var(--danger);background:var(--danger-bg)}
.notice[data-tone="warn"]{border-left-color:var(--warn);background:var(--warn-bg)}
.notice[data-tone="ok"]{border-left-color:var(--ok);background:var(--ok-bg)}
.notice[data-tone="info"]{border-left-color:var(--info);background:var(--info-bg)}
.notice > :first-child{margin-top:0}
.notice > :last-child{margin-bottom:0}
.card{border:1px solid var(--line);border-radius:12px;padding:1.1rem 1.25rem;margin:1rem 0;background:var(--bg)}
.badge{display:inline-block;padding:.05rem .55rem;border-radius:999px;font-size:.8rem;font-weight:600;white-space:nowrap;background:var(--surface)}
.badge[data-tone="ok"]{color:var(--ok);background:var(--ok-bg)}
.badge[data-tone="error"]{color:var(--danger);background:var(--danger-bg)}
.badge[data-tone="warn"]{color:var(--warn);background:var(--warn-bg)}
.badge[data-tone="info"]{color:var(--info);background:var(--info-bg)}
.badge[data-tone="muted"]{color:var(--muted)}
dl.facts{display:grid;grid-template-columns:minmax(8rem,max-content) 1fr;gap:.35rem 1.5rem;margin:0}
dl.facts dt{color:var(--muted);font-weight:600}
dl.facts dd{margin:0;overflow-wrap:anywhere}
figure.reason{margin:1rem 0;padding:.25rem 0 .25rem 1rem;border-left:3px solid var(--border)}
figure.reason figcaption{color:var(--muted);font-size:.9rem}
figure.reason blockquote{margin:.25rem 0 0;overflow-wrap:anywhere}
ul.hints{list-style:none;padding:0;margin:.5rem 0 0;display:grid;gap:.45rem}
ul.hints li{display:flex;align-items:baseline;gap:.6rem}
pre{overflow-x:auto;max-width:100%}
code,pre,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9rem}
pre.args,pre.body{margin:0;padding:1rem;background:var(--surface);border:1px solid var(--border);border-radius:4px;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
.table-scroll{overflow-x:auto;max-width:100%;border:1px solid var(--line);border-radius:12px;margin:.75rem 0;background:linear-gradient(to right,var(--bg) 30%,transparent) left/2rem 100% no-repeat local,linear-gradient(to left,var(--bg) 30%,transparent) right/2rem 100% no-repeat local,radial-gradient(farthest-side at 0 50%,rgb(0 0 0 / .18),transparent) left/.75rem 100% no-repeat scroll,radial-gradient(farthest-side at 100% 50%,rgb(0 0 0 / .18),transparent) right/.75rem 100% no-repeat scroll}
table.data{width:100%;border-collapse:collapse;margin:0;background:var(--bg)}
table.data caption{text-align:left;font-weight:600;padding:.6rem .85rem;color:var(--muted);font-size:.85rem;background:var(--bg)}
table.data th,table.data td{text-align:left;vertical-align:top;padding:.6rem .85rem;border-bottom:1px solid var(--line);overflow-wrap:break-word}
table.data tbody tr:last-child > *{border-bottom:0}
table.data thead th{border-bottom:1px solid var(--line);color:var(--muted);font-size:.8rem;font-weight:600;letter-spacing:.02em;background:var(--surface)}
.btn{font:inherit;font-size:.93rem;font-weight:600;white-space:nowrap;padding:.5rem 1rem;border-radius:9px;border:1px solid var(--accent);cursor:pointer;min-height:2.5rem}
.btn-primary{background:var(--accent);color:var(--accent-text)}
.btn-secondary{background:var(--bg);color:var(--text);border-color:var(--border)}
.btn-danger{background:var(--bg);border-color:var(--danger);color:var(--danger)}
.btn:disabled{cursor:not-allowed;opacity:.55}
a.btn{display:inline-block;text-decoration:none}
form.filters{display:flex;flex-wrap:wrap;gap:.5rem .75rem;align-items:center;margin:1rem 0;padding:.75rem;background:var(--bg);border:1px solid var(--line);border-radius:12px}
form.filters label{color:var(--muted);font-size:.88rem}
.actions{display:flex;flex-wrap:wrap;gap:.75rem;align-items:center;margin:1rem 0}
fieldset{border:1px solid var(--line);border-radius:10px;padding:.75rem 1rem;margin:1rem 0}
legend{font-weight:600;padding:0 .25rem}
label{cursor:pointer}
.choice{display:flex;gap:.5rem;align-items:baseline;margin:.25rem 0}
select,textarea,input[type="text"],input:not([type]){font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:.45rem .6rem}
textarea{width:100%;min-height:5rem}
.diff{margin:0;padding:0;list-style:none;border:1px solid var(--border);border-radius:4px;overflow:hidden}
.diff li{padding:0 .75rem;white-space:pre-wrap;overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9rem}
.diff li[data-op="add"]{background:var(--add-bg)}
.diff li[data-op="remove"]{background:var(--remove-bg)}
.diff .sign{display:inline-block;width:1.25rem;font-weight:700}
body:has(.ap){background:var(--page)}
.ap{max-width:44rem;margin:0 auto}
.ap .card{background:var(--bg);border-radius:12px;margin:.75rem 0}
.ap-head{padding:1.1rem 1.25rem}
.ap-meta{display:flex;flex-wrap:wrap;align-items:center;gap:.25rem .75rem;font-size:.9rem}
.ap-meta .badge{margin-left:auto}
.ap-agent{font-weight:600}
.ap-title{font-size:1.35rem;line-height:1.35;margin:.6rem 0 0;letter-spacing:-.01em;overflow-wrap:anywhere}
.ap-title mark{background:var(--surface);color:inherit;border-radius:6px;padding:0 .3rem}
.ap .reason{margin:.9rem 0 0}
.ap-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:.5rem;list-style:none;margin:1rem 0 0;padding:0}
.ap-fact{background:var(--surface);border-radius:8px;padding:.5rem .7rem;display:flex;flex-direction:column;min-width:0}
.ap-fact span{color:var(--muted);font-size:.8rem}
.ap-fact strong{font-weight:600;font-size:.95rem;overflow-wrap:anywhere}
.ap-card-head{display:flex;justify-content:space-between;align-items:baseline;gap:1rem;margin-bottom:.25rem}
.ap-card-head h2{font-size:1rem;margin:0}
.ap-card-head .muted{font-size:.85rem}
.ap-row{display:grid;grid-template-columns:minmax(5.5rem,max-content) minmax(0,1fr);gap:.75rem;padding:.6rem 0;border-top:1px solid var(--border);align-items:start}
.ap-card-head + .ap-row{border-top:0}
.ap-key{color:var(--muted);font-size:.9rem;overflow-wrap:anywhere}
.ap-row pre.body{max-height:16rem;overflow:auto}
.ap-domains,.ap-addresses{list-style:none;margin:0;padding:0;display:grid;gap:.35rem}
.ap-addresses{margin-top:.4rem;font-size:.9rem}
.ap-chip{display:inline-block;background:var(--surface);border-radius:6px;padding:0 .45rem;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9rem;overflow-wrap:anywhere}
.ap-chip.is-outside{box-shadow:inset 0 0 0 1px var(--warn)}
.ap-outside{color:var(--warn);font-size:.8rem;font-weight:600}
.ap-fold summary,.ap-details summary,.ap-more summary{cursor:pointer}
.ap-details details + details{border-top:1px solid var(--border);margin-top:.75rem;padding-top:.75rem}
.ap-details summary{font-weight:600}
.ap-details dl.facts{margin-top:.75rem}
.ap-details pre.args{margin-top:.5rem}
.ap-decide{position:sticky;bottom:0;margin:.75rem 0 1rem;padding:.75rem;background:var(--bg);border:1px solid var(--border);border-radius:12px;box-shadow:0 10px 30px -18px rgb(0 0 0 / .45)}
.ap-decide:has(.ap-more[open]){position:static}
.ap-bar{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem .75rem}
.ap-bar [data-heel-ceremony="deny"]{order:-1;background:transparent;color:var(--danger)}
.ap .btn{border-radius:9px}
.ap-bar [data-heel-ceremony="approve-once"]{order:2}
.ap-note{flex:1;margin:0;color:var(--muted);font-size:.85rem;text-align:center;min-width:10rem}
.ap-more{margin-top:.5rem}
.ap-more summary{color:var(--muted);font-size:.9rem}
.ap-more fieldset{margin:.75rem 0 0}
@media (max-width:36rem){
  main:has(.ap){padding:1rem .75rem}
  .ap-title{font-size:1.15rem}
  .ap-row{grid-template-columns:1fr;gap:.25rem}
  .ap-bar .btn{flex:1}
  .ap-note{order:3;flex-basis:100%;font-size:.8rem}
  .ap-decide{padding:.5rem .6rem;margin-bottom:.5rem}
  .ap-more{margin-top:.25rem}
  .site{padding:.6rem 1rem;gap:.5rem 1rem}
  .site .who{margin-left:0;flex-basis:100%;font-size:.9rem}
  main{padding:1rem}
  table.data{min-width:34rem}
}
.conn-list{list-style:none;margin:.75rem 0 1rem;padding:0;display:grid;gap:.75rem;align-items:start;grid-template-columns:repeat(auto-fill,minmax(17rem,1fr))}
.conn{margin:0;display:flex;flex-direction:column;gap:.75rem}
.conn-head{display:flex;justify-content:space-between;align-items:flex-start;gap:.75rem}
.conn-name{font-size:1rem;margin:0;overflow-wrap:anywhere}
.conn-kind{margin:.1rem 0 0;font-size:.88rem}
.conn-step{border-top:1px solid var(--line);padding-top:.75rem;font-size:.9rem}
.conn-add h2{font-size:1rem;margin:0 0 .25rem}
.conn-add pre.args{margin-top:.75rem}
.story{border-top:4px solid var(--border);margin-top:2rem;padding-top:1rem}
.visually-hidden{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.signin{max-width:28rem;margin:3rem auto}
[role="status"]:empty{display:none}
#heel-ceremony-status:not(:empty){position:fixed;left:1rem;right:1rem;bottom:1rem;max-width:56rem;margin:0 auto;z-index:20;padding:.75rem 1rem;background:var(--surface);color:var(--text);border:1px solid var(--border);border-left:6px solid var(--info);border-radius:4px;box-shadow:0 4px 16px rgb(0 0 0 / .25);overflow-wrap:anywhere}
body:has(#heel-ceremony-status:not(:empty)) main{padding-bottom:10rem}
`;

/** The full stylesheet for every human-plane page. */
export const STYLESHEET = [
  `:root{${variables(LIGHT)}}`,
  `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${variables(DARK)}}}`,
  `:root[data-theme="dark"]{${variables(DARK)}}`,
  RULES,
].join("\n");

/** Exposed for the contrast test, which checks each pair the pages use. */
export const PALETTES = { light: LIGHT, dark: DARK } as const;
