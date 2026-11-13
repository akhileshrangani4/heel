/**
 * The human plane's stylesheet. One palette per theme, both chosen for WCAG
 * AA contrast on their own background; the light/dark switch follows the
 * operating system unless the page sets `data-theme`. Status is always also
 * spelled out in text, never carried by colour alone.
 */

const LIGHT = {
  bg: "#ffffff",
  surface: "#f4f5f7",
  text: "#1a1d23",
  muted: "#4a5160",
  border: "#b9c0cc",
  accent: "#1d4fa8",
  "accent-text": "#ffffff",
  danger: "#a8201a",
  "danger-text": "#ffffff",
  ok: "#14632b",
  warn: "#7a4f00",
  info: "#1d4fa8",
  "banner-bg": "#fff4d6",
  "banner-text": "#4d3200",
  "add-bg": "#e3f4e7",
  "remove-bg": "#fbe5e3",
  focus: "#0b57d0",
} as const;

/** Every theme defines every colour the stylesheet uses. */
type Palette = Readonly<Record<keyof typeof LIGHT, string>>;

const DARK: Palette = {
  bg: "#111318",
  surface: "#1b1e25",
  text: "#e8eaef",
  muted: "#aab1bf",
  border: "#454b58",
  accent: "#8ab4f8",
  "accent-text": "#0b1220",
  danger: "#ff8a80",
  "danger-text": "#240503",
  ok: "#7ddc8f",
  warn: "#f2c25c",
  info: "#8ab4f8",
  "banner-bg": "#3a2c05",
  "banner-text": "#ffe7a3",
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
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent)}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
.skip{position:absolute;left:-9999px;top:0;padding:.5rem 1rem;background:var(--bg)}
.skip:focus{left:1rem;top:1rem;z-index:10}
.site{display:flex;flex-wrap:wrap;gap:1rem 2rem;align-items:center;padding:.75rem 1.5rem;border-bottom:1px solid var(--border);background:var(--surface)}
.site .brand{font-weight:700;font-size:1.1rem;color:var(--text);text-decoration:none}
.site nav ul{display:flex;gap:1rem;list-style:none;margin:0;padding:0}
.site nav a{text-decoration:none;padding:.25rem .125rem}
.site nav a[aria-current="page"]{font-weight:700;text-decoration:underline;text-underline-offset:.3em}
.site .who{margin-left:auto;color:var(--muted)}
main{max-width:72rem;margin:0 auto;padding:1.5rem}
h1{font-size:1.6rem;margin:0 0 .5rem}
h2{font-size:1.2rem;margin:1.5rem 0 .5rem}
h3{font-size:1rem;margin:1rem 0 .5rem}
p{margin:.5rem 0}
.muted{color:var(--muted)}
.banner{padding:.75rem 1.5rem;background:var(--banner-bg);color:var(--banner-text);border-bottom:1px solid var(--border);font-weight:600}
.notice{border:1px solid var(--border);border-left-width:6px;padding:.75rem 1rem;margin:1rem 0;background:var(--surface);border-radius:4px}
.notice[data-tone="error"]{border-left-color:var(--danger)}
.notice[data-tone="warn"]{border-left-color:var(--warn)}
.notice[data-tone="ok"]{border-left-color:var(--ok)}
.notice[data-tone="info"]{border-left-color:var(--info)}
.notice > :first-child{margin-top:0}
.notice > :last-child{margin-bottom:0}
.card{border:1px solid var(--border);border-radius:6px;padding:1rem 1.25rem;margin:1rem 0;background:var(--bg)}
.badge{display:inline-block;padding:0 .5rem;border:1px solid currentColor;border-radius:999px;font-size:.85rem;font-weight:600;white-space:nowrap}
.badge[data-tone="ok"]{color:var(--ok)}
.badge[data-tone="error"]{color:var(--danger)}
.badge[data-tone="warn"]{color:var(--warn)}
.badge[data-tone="info"]{color:var(--info)}
.badge[data-tone="muted"]{color:var(--muted)}
dl.facts{display:grid;grid-template-columns:minmax(8rem,max-content) 1fr;gap:.35rem 1.5rem;margin:0}
dl.facts dt{color:var(--muted);font-weight:600}
dl.facts dd{margin:0;overflow-wrap:anywhere}
code,pre,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9rem}
pre.args,pre.body{margin:0;padding:1rem;background:var(--surface);border:1px solid var(--border);border-radius:4px;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
table.data{width:100%;border-collapse:collapse;margin:.5rem 0}
table.data caption{text-align:left;font-weight:600;padding:.25rem 0;color:var(--muted)}
table.data th,table.data td{text-align:left;vertical-align:top;padding:.5rem .75rem;border-bottom:1px solid var(--border);overflow-wrap:anywhere}
table.data thead th{border-bottom-width:2px}
.btn{font:inherit;font-weight:600;padding:.5rem 1rem;border-radius:6px;border:2px solid var(--accent);cursor:pointer;min-height:2.5rem}
.btn-primary{background:var(--accent);color:var(--accent-text)}
.btn-secondary{background:transparent;color:var(--accent)}
.btn-danger{background:var(--danger);border-color:var(--danger);color:var(--danger-text)}
.btn:disabled{cursor:not-allowed;opacity:.55}
a.btn{display:inline-block;text-decoration:none}
.actions{display:flex;flex-wrap:wrap;gap:.75rem;align-items:center;margin:1rem 0}
fieldset{border:1px solid var(--border);border-radius:6px;padding:.75rem 1rem;margin:1rem 0}
legend{font-weight:600;padding:0 .25rem}
label{cursor:pointer}
.choice{display:flex;gap:.5rem;align-items:baseline;margin:.25rem 0}
select,textarea,input[type="text"]{font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:.4rem .5rem}
textarea{width:100%;min-height:5rem}
.diff{margin:0;padding:0;list-style:none;border:1px solid var(--border);border-radius:4px;overflow:hidden}
.diff li{padding:0 .75rem;white-space:pre-wrap;overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9rem}
.diff li[data-op="add"]{background:var(--add-bg)}
.diff li[data-op="remove"]{background:var(--remove-bg)}
.diff .sign{display:inline-block;width:1.25rem;font-weight:700}
.story{border-top:4px solid var(--border);margin-top:2rem;padding-top:1rem}
.visually-hidden{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.signin{max-width:28rem;margin:3rem auto}
[role="status"]:empty{display:none}
#heel-ceremony-status:not(:empty){position:fixed;left:1rem;right:1rem;bottom:1rem;max-width:56rem;margin:0 auto;z-index:20;padding:.75rem 1rem;background:var(--surface);color:var(--text);border:1px solid var(--border);border-left:6px solid var(--info);border-radius:4px;box-shadow:0 4px 16px rgb(0 0 0 / .25)}
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
