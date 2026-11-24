import { ACTIVITY_CSS } from "./styles/activity.ts";
import { AGENTS_CSS } from "./styles/agents.ts";
import { APPROVALS_CSS } from "./styles/approvals.ts";
import { CONNECTIONS_CSS } from "./styles/connections.ts";
import { HOME_CSS } from "./styles/home.ts";
import { RULES_CSS } from "./styles/rules.ts";
import { SETTINGS_CSS } from "./styles/settings.ts";
import { TAILWIND_CSS } from "./styles/tailwind.ts";

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
  /** The dot grid behind every page, as on useheel.dev. */
  dot: "rgb(0 0 0 / .07)",
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
  dot: "rgb(255 255 255 / .06)",
};

function variables(palette: Palette): string {
  return Object.entries(palette)
    .map(([name, value]) => `--${name}:${value};`)
    .join("");
}

const RULES = `
*,*::before,*::after{box-sizing:border-box}
[hidden]{display:none!important}
.ui-select-native{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0 0 0 0)!important;white-space:nowrap!important;border:0!important;opacity:0!important;pointer-events:none!important}
.ui-select{position:relative;display:inline-flex;max-width:100%;min-width:0;vertical-align:middle}
.ui-select-trigger{display:inline-flex;align-items:center;justify-content:space-between;gap:.5rem;height:2.25rem;width:100%;min-width:8rem;max-width:100%;padding:0 .6rem 0 .75rem;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font:inherit;font-size:.875rem;line-height:1.25;text-align:left;white-space:nowrap;cursor:pointer;box-shadow:0 1px 2px rgb(0 0 0 / .05);transition:border-color .15s,box-shadow .15s}
.ui-select-trigger:hover{background:color-mix(in srgb,var(--surface) 50%,var(--bg))}
.ui-select-trigger:focus-visible{outline:none;border-color:var(--focus);box-shadow:0 0 0 3px color-mix(in srgb,var(--focus) 35%,transparent)}
.ui-select-trigger[aria-expanded="true"]{border-color:var(--focus);box-shadow:0 0 0 3px color-mix(in srgb,var(--focus) 25%,transparent)}
.ui-select-trigger:disabled{opacity:.5;cursor:not-allowed}
.ui-select-value{min-width:0}
.ui-select-chevron{display:inline-flex;flex:none;color:var(--muted)}
.ui-select-chevron svg{width:1rem;height:1rem}
.ui-select-content{position:absolute;left:0;top:calc(100% + .3rem);z-index:60;min-width:100%;width:max-content;max-width:min(22rem,calc(100vw - 2rem));max-height:18rem;overflow-y:auto;padding:.25rem;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text);box-shadow:0 10px 28px -10px rgb(0 0 0 / .3),0 2px 6px -2px rgb(0 0 0 / .08)}
.ui-select-content.is-up{top:auto;bottom:calc(100% + .3rem)}
.ui-select-item{display:flex;align-items:center;justify-content:space-between;gap:.75rem;padding:.4rem .5rem;border-radius:6px;font-size:.875rem;cursor:pointer;user-select:none}
.ui-select-item.is-active{background:var(--surface)}
.ui-select-item[aria-disabled="true"]{opacity:.5;cursor:not-allowed}
.ui-select-check{display:inline-flex;flex:none;width:1rem;color:var(--text);visibility:hidden}
.ui-select-check svg{width:1rem;height:1rem}
.ui-select-item[aria-selected="true"] .ui-select-check{visibility:visible}
.ui-select-item[aria-selected="true"]{font-weight:500}

.ui-dialog{padding:0;border:1px solid var(--line);border-radius:14px;background:var(--bg);color:var(--text);width:min(30rem,calc(100vw - 2rem));max-height:calc(100vh - 2rem);box-shadow:0 24px 60px -20px rgb(0 0 0 / .45)}
.ui-dialog-wide{width:min(46rem,calc(100vw - 2rem))}
.ui-dialog::backdrop{background:rgb(0 0 0 / .45);backdrop-filter:blur(2px)}
.ui-dialog-panel{padding:1.25rem 1.25rem 1.4rem;overflow:auto;max-height:calc(100vh - 2rem)}
.ui-dialog-head{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-bottom:.25rem}
.ui-dialog-title{font-size:1.05rem;margin:0}
.ui-dialog-desc{margin:0 0 1rem;font-size:.88rem}
html{color-scheme:light dark}
body{margin:0;background-color:var(--page);background-image:radial-gradient(circle,var(--dot) 1px,transparent 1px);background-size:22px 22px;color:var(--text);font:15px/1.55 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--link);text-underline-offset:.2em}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
.skip{position:absolute;left:-9999px;top:0;padding:.5rem 1rem;background:var(--bg)}
.skip:focus{left:1rem;top:1rem;z-index:10}
.site{display:flex;flex-wrap:wrap;gap:.75rem 2rem;align-items:center;max-width:72rem;margin:0 auto;padding:.9rem 1.5rem}
.site .brand{display:inline-flex;align-items:center;gap:.5rem;font-weight:600;font-size:1.15rem;letter-spacing:-.02em;color:var(--text);text-decoration:none}
.site .brand svg{width:1.6rem;height:1.6rem;flex:none}
.site nav{max-width:100%}
.site nav ul{display:flex;flex-wrap:wrap;gap:.25rem 1rem;list-style:none;margin:0;padding:0}
.site nav a{text-decoration:none;padding:.3rem .55rem;border-radius:8px;white-space:nowrap;display:inline-block;color:var(--muted);font-size:.93rem}
.site nav a:hover{color:var(--text);background:var(--surface)}
.site nav a[aria-current="page"]{color:var(--text);font-weight:600;background:var(--bg);box-shadow:inset 0 0 0 1px var(--line),0 1px 2px rgb(0 0 0 / .05)}
.site .account{margin-left:auto;display:flex;align-items:center;gap:.75rem}
.site .who{color:var(--muted);font-size:.88rem}
.site .sign-out{font:inherit;font-size:.88rem;color:var(--muted);background:none;border:0;padding:.3rem .55rem;border-radius:8px;cursor:pointer}
.site .sign-out:hover{color:var(--text);background:var(--surface)}
.subnav{margin:0 0 1rem}
.subnav ul{display:flex;flex-wrap:wrap;gap:.25rem;list-style:none;margin:0;padding:.25rem;background:var(--surface);border-radius:10px;width:fit-content;max-width:100%}
.subnav a{display:inline-block;padding:.3rem .7rem;border-radius:7px;color:var(--muted);text-decoration:none;font-size:.9rem;white-space:nowrap}
.subnav a[aria-current="page"]{background:var(--bg);color:var(--text);font-weight:600;box-shadow:0 1px 2px rgb(0 0 0 / .08)}
main{max-width:72rem;margin:0 auto;padding:1.5rem}
h1{font-size:1.85rem;line-height:1.2;letter-spacing:-.04em;font-weight:600;margin:0 0 .5rem}
h2{font-size:1.2rem;letter-spacing:-.02em;margin:1.5rem 0 .5rem}
h3{font-size:1rem;margin:1rem 0 .5rem}
p{margin:.5rem 0}
.muted{color:var(--muted)}
.banner{padding:.7rem 1.5rem;background:var(--banner-bg);color:var(--banner-text);font-weight:600;text-align:center}
.pause-alert{display:flex;align-items:center;gap:.6rem;margin:0 0 1.25rem;padding:.6rem .85rem;border:1px solid color-mix(in srgb,var(--warn) 35%,transparent);border-radius:10px;background:var(--warn-bg);color:var(--banner-text);font-size:.88rem}
.pause-alert-icon{flex:none;display:inline-flex;color:var(--warn)}
.pause-alert-icon svg{width:1.1rem;height:1.1rem}
.pause-alert-text{flex:1;min-width:0;overflow-wrap:anywhere}
.pause-alert-action{flex:none;font-weight:600;color:var(--banner-text);text-underline-offset:.2em}
.notice{display:flex;align-items:flex-start;gap:.6rem;margin:1rem 0;padding:.6rem .85rem;border:1px solid var(--line);border-radius:10px;background:var(--bg);font-size:.9rem}
.notice-icon{flex:none;display:inline-flex;margin-top:.15rem}
.notice-icon svg{width:1.05rem;height:1.05rem}
.notice-body{flex:1;min-width:0;overflow-wrap:anywhere}
.notice-body > :first-child{margin-top:0}
.notice-body > :last-child{margin-bottom:0}
.notice[data-tone="error"]{background:var(--danger-bg);border-color:color-mix(in srgb,var(--danger) 30%,transparent)}
.notice[data-tone="error"] .notice-icon{color:var(--danger)}
.notice[data-tone="warn"]{background:var(--warn-bg);border-color:color-mix(in srgb,var(--warn) 30%,transparent)}
.notice[data-tone="warn"] .notice-icon{color:var(--warn)}
.notice[data-tone="ok"]{background:var(--ok-bg);border-color:color-mix(in srgb,var(--ok) 30%,transparent)}
.notice[data-tone="ok"] .notice-icon{color:var(--ok)}
.notice[data-tone="info"]{background:var(--info-bg);border-color:color-mix(in srgb,var(--info) 30%,transparent)}
.notice[data-tone="info"] .notice-icon{color:var(--info)}
.card{border:1px solid var(--line);border-radius:16px;padding:1.1rem 1.25rem;margin:1rem 0;background:var(--bg);box-shadow:0 1px 2px rgb(0 0 0 / .04)}
.badge{display:inline-flex;align-items:center;gap:.35rem;padding:.1rem .55rem;border-radius:999px;border:0;font:500 .75rem/1.5 inherit;font-family:inherit;white-space:nowrap;background:var(--surface);color:var(--muted)}
.badge::before{content:"";flex:none;width:.4rem;height:.4rem;border-radius:999px;background:currentColor}
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
code,pre,.mono{font-family:ui-monospace,"Geist Mono",SFMono-Regular,Menlo,Consolas,monospace;font-size:.9rem}
pre.args,pre.body{margin:0;padding:1rem;background:var(--surface);border:1px solid var(--line);border-radius:10px;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
.table-scroll{position:relative;overflow-x:auto;max-width:100%;border:1px solid var(--line);border-radius:14px;margin:.75rem 0;background:linear-gradient(to right,var(--bg) 30%,transparent) left/2rem 100% no-repeat local,linear-gradient(to left,var(--bg) 30%,transparent) right/2rem 100% no-repeat local,radial-gradient(farthest-side at 0 50%,rgb(0 0 0 / .18),transparent) left/.75rem 100% no-repeat scroll,radial-gradient(farthest-side at 100% 50%,rgb(0 0 0 / .18),transparent) right/.75rem 100% no-repeat scroll}
.btn{font-family:inherit;line-height:1.25;border:0 solid var(--line);background-color:transparent;color:inherit;cursor:pointer}
a.btn{text-decoration:none}
table.data{border-collapse:collapse;margin:0;background:var(--bg)}
table.data th,table.data td{overflow-wrap:break-word}
select,textarea,input{font:inherit;color:var(--text)}
form.filters{display:flex;flex-wrap:wrap;gap:.5rem .75rem;align-items:center;margin:1rem 0;padding:.75rem;background:var(--bg);border:1px solid var(--line);border-radius:16px}
form.filters label{color:var(--muted);font-size:.88rem}
.actions{display:flex;flex-wrap:wrap;gap:.75rem;align-items:center;margin:1rem 0}
fieldset{border:1px solid var(--line);border-radius:10px;padding:.75rem 1rem;margin:1rem 0}
legend{font-weight:600;padding:0 .25rem}
label{cursor:pointer}
button:not(:disabled),[role="button"],summary,select,input[type="radio"],input[type="checkbox"],input[type="submit"]{cursor:pointer}
.choice{display:flex;gap:.5rem;align-items:baseline;margin:.25rem 0}
.paste-form{display:grid;gap:.5rem;margin:.75rem 0;max-width:40rem}
.paste-form label{font-weight:600}
.paste-form input{width:100%;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9rem}
.paste-form .btn{justify-self:start}
.steps{padding-left:1.25rem}
.steps > li{margin:0 0 1.25rem}
.diff{margin:0;padding:0;list-style:none;border:1px solid var(--line);border-radius:10px;overflow:hidden}
.diff li{padding:0 .75rem;white-space:pre-wrap;overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9rem}
.diff li[data-op="add"]{background:var(--add-bg)}
.diff li[data-op="remove"]{background:var(--remove-bg)}
.diff .sign{display:inline-block;width:1.25rem;font-weight:700}
.ap{max-width:44rem;margin:0 auto}
.ap .card{background:var(--bg);border-radius:16px;margin:.75rem 0}
.ap-head{padding:1.25rem 1.4rem;box-shadow:0 24px 60px -32px rgb(0 0 0 / .35)}
.ap-meta{display:flex;flex-wrap:wrap;align-items:center;gap:.25rem .75rem;font-size:.9rem;color:var(--muted)}
.ap-meta .badge{margin-left:auto}
.ap-agent{font-weight:600;color:var(--text)}
.ap-title{font-size:1.45rem;line-height:1.35;margin:.7rem 0 0;letter-spacing:-.03em;font-weight:600;overflow-wrap:anywhere}
.ap-title mark{background:var(--surface);color:inherit;border-radius:8px;padding:0 .35rem;box-shadow:inset 0 0 0 1px var(--line)}
.ap .reason{margin:.9rem 0 0}
.ap-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:.5rem;list-style:none;margin:1rem 0 0;padding:0}
.ap-fact{background:var(--surface);border-radius:10px;padding:.55rem .75rem;display:flex;flex-direction:column;min-width:0}
.ap-fact span{color:var(--muted);font:.72rem/1.6 ui-monospace,"Geist Mono",SFMono-Regular,Menlo,Consolas,monospace}
.ap-fact strong{font-weight:600;font-size:.95rem;overflow-wrap:anywhere}
.ap-card-head{display:flex;justify-content:space-between;align-items:baseline;gap:1rem;margin-bottom:.25rem}
.ap-card-head h2{font-size:1rem;margin:0}
.ap-card-head .muted{font:.75rem ui-monospace,"Geist Mono",SFMono-Regular,Menlo,Consolas,monospace}
.ap-row{display:grid;grid-template-columns:minmax(5.5rem,max-content) minmax(0,1fr);gap:.75rem;padding:.6rem 0;border-top:1px solid var(--line);align-items:start}
.ap-card-head + .ap-row{border-top:0}
.ap-key{color:var(--muted);font-size:.9rem;overflow-wrap:anywhere}
.ap-row pre.body{max-height:16rem;overflow:auto}
.ap-domains,.ap-addresses{list-style:none;margin:0;padding:0;display:grid;gap:.35rem}
.ap-addresses{margin-top:.4rem;font-size:.9rem}
.ap-chip{display:inline-block;background:var(--surface);border-radius:6px;padding:0 .45rem;font-family:ui-monospace,"Geist Mono",SFMono-Regular,Menlo,Consolas,monospace;font-size:.9rem;overflow-wrap:anywhere}
.ap-chip.is-outside{box-shadow:inset 0 0 0 1px var(--warn)}
.ap-outside{color:var(--warn);font-size:.8rem;font-weight:600}
.ap-fold summary,.ap-details summary,.ap-more summary{cursor:pointer}
.ap-details details + details{border-top:1px solid var(--line);margin-top:.75rem;padding-top:.75rem}
.ap-details summary{font-weight:600}
.ap-details dl.facts{margin-top:.75rem}
.ap-details pre.args{margin-top:.5rem}
.ap-decide{margin:.75rem 0;padding:.75rem;background:var(--bg);border:1px solid var(--line);border-radius:16px;box-shadow:0 1px 2px rgb(0 0 0 / .04)}
.ap-bar{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem .75rem}
.ap-bar [data-heel-ceremony="deny"]{order:-1;background:transparent;color:var(--danger)}
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
  main{padding:1rem}
  table.data{min-width:34rem}
}
.req-list{list-style:none;margin:.75rem 0 2rem;padding:0;display:grid;gap:.75rem}
.req{margin:0}
.req .ap-meta{display:block;line-height:1.75}
.req .ap-meta > *{display:inline-block;white-space:nowrap;margin-right:.75rem}
.req .ap-meta .badge{float:right;margin:0 0 0 .75rem;line-height:1.5}
.req-title{font-size:1.1rem;line-height:1.4;margin:.5rem 0 0;font-weight:600;overflow-wrap:anywhere}
.req-title a{color:var(--text);text-decoration:none}
.req-title a:hover{text-decoration:underline}
.req-title mark{background:var(--surface);color:inherit;border-radius:8px;padding:0 .35rem;box-shadow:inset 0 0 0 1px var(--line)}
.req[data-status="pending"]{border-color:var(--line)}
.req-reason{margin:.5rem 0 0;padding-left:.75rem;border-left:2px solid var(--line)}
.req-foot{margin:.6rem 0 0;font-size:.85rem}
.req-count{margin:0}
.req-foot-row{display:flex;justify-content:space-between;align-items:center;gap:.75rem;flex-wrap:wrap;margin-top:.5rem}
.req-foot-row .req-foot{margin:0;overflow-wrap:anywhere}
.grant-form,.stack-form{display:grid;gap:.4rem .75rem;grid-template-columns:minmax(7rem,max-content) minmax(0,1fr);align-items:center}
.stack-form .row{display:contents}.stack-form .row[hidden]{display:none}
.stack-form label{color:var(--muted);font-size:.9rem}
.stack-form .btn{grid-column:2;justify-self:start;margin-top:.25rem}
.stack-form .muted{grid-column:1/-1;margin:0}
.stack-form input[type="checkbox"]{justify-self:start}
.plain-list{list-style:none;padding:0;margin:.25rem 0 .75rem}
.plain-list li{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;padding:.2rem 0}
.plain-list form{display:inline;margin:0}
.conn-manage h3{font-size:1rem;margin:1rem 0 .4rem}
@media (max-width:36rem){.stack-form{grid-template-columns:1fr}.stack-form .btn{grid-column:1}}
.grant-form h2{grid-column:1/-1;font-size:1rem;margin:0 0 .25rem}
.grant-form label{color:var(--muted);font-size:.9rem}
.grant-form .btn{grid-column:2;justify-self:start;margin-top:.25rem}
@media (max-width:36rem){.grant-form{grid-template-columns:1fr}.grant-form .btn{grid-column:1}}
.req-empty{text-align:center;padding:2rem 1rem}
.conn-list{list-style:none;margin:.75rem 0 1rem;padding:0;display:grid;gap:.75rem;align-items:start;grid-template-columns:repeat(auto-fill,minmax(17rem,1fr))}
.conn{margin:0;display:flex;flex-direction:column;gap:.75rem}
.conn-head{display:flex;justify-content:space-between;align-items:flex-start;gap:.75rem}
.conn-name{font-size:1rem;margin:0;overflow-wrap:anywhere}
.conn-kind{margin:.1rem 0 0;font-size:.88rem}
.conn-step{border-top:1px solid var(--line);padding-top:.75rem;font-size:.9rem}
.conn-name a{color:var(--text);text-decoration:none}
.conn-name a:hover{text-decoration:underline}
.agent-stats{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:.35rem}
.agent-stats li{background:var(--surface);border-radius:8px;padding:.4rem .55rem;display:flex;flex-direction:column}
.agent-stats strong{font-size:1.05rem}
.agent-stats span{color:var(--muted);font-size:.75rem}
.agent-foot{margin:0;font-size:.85rem;border-top:1px solid var(--line);padding-top:.6rem}
.pause-status{display:flex;flex-direction:column;gap:.5rem}
.pause-status p{margin:0}
.pause-all{display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap}
.pause-all h3,.pause-groups h3{margin:0 0 .15rem;font-size:1rem}
.pause-all p{margin:0}
.pause-groups{display:grid;gap:.75rem;grid-template-columns:repeat(auto-fit,minmax(17rem,1fr));align-items:start}
.pause-groups .card{margin:0}
.pause-list{list-style:none;margin:.25rem 0 0;padding:0}
.pause-list li{display:flex;justify-content:space-between;align-items:center;gap:.75rem;flex-wrap:wrap;padding:.55rem 0;border-top:1px solid var(--line)}
.pause-list li:first-child{border-top:0}
.pause-list li > div:first-child{display:flex;flex-direction:column}
.pause-resume{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
.conn-add h2{font-size:1rem;margin:0 0 .25rem}
.conn-add pre.args{margin-top:.75rem}
.story{border-top:4px solid var(--border);margin-top:2rem;padding-top:1rem}
.visually-hidden{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
main:has(.auth){max-width:none;padding:0}
.auth{position:relative;isolation:isolate;max-width:1100px;margin:0 auto;padding:6rem 1.25rem 3rem;display:flex;flex-direction:column;align-items:center;text-align:center;min-height:100vh}
.auth-dog{position:absolute;top:2rem;left:50%;z-index:-1;transform:translateX(calc(-50% - 2.6ch + 2px));margin:0;text-align:left;font-size:13px;line-height:1;color:color-mix(in srgb,var(--text) 7%,transparent);white-space:pre;overflow:visible;background:none;border:0;padding:0;pointer-events:none;user-select:none;-webkit-mask-image:linear-gradient(to bottom,#000 40%,transparent 75%);mask-image:linear-gradient(to bottom,#000 40%,transparent 75%)}
.auth-word{margin:0;font-size:clamp(3.5rem,11vw,5.5rem);line-height:1;font-weight:600;letter-spacing:-.06em}
.auth-tag{margin:.6rem 0 2rem;font-size:1.1rem;color:var(--muted)}
.auth-foot{margin:1.25rem 0 0;font-size:.78rem;color:var(--muted)}
.sticker{position:absolute;display:none;border:1px solid;border-radius:6px;padding:.2rem .6rem;font:500 .75rem ui-monospace,SFMono-Regular,Menlo,monospace;box-shadow:0 1px 2px rgb(0 0 0 / .06)}
.sticker-allow{top:7rem;left:12%;transform:rotate(-6deg);color:var(--ok);background:var(--ok-bg);border-color:color-mix(in srgb,var(--ok) 35%,transparent)}
.sticker-deny{top:10rem;right:12%;transform:rotate(8deg);color:var(--danger);background:var(--danger-bg);border-color:color-mix(in srgb,var(--danger) 35%,transparent)}
.sticker-ask{top:21rem;left:17%;transform:rotate(4deg);color:var(--warn);background:var(--warn-bg);border-color:color-mix(in srgb,var(--warn) 35%,transparent)}
@media (min-width:56rem){.sticker{display:block}}
.signin{width:100%;max-width:25rem;margin:0;padding:1.75rem;text-align:left;background:var(--bg);border:1px solid var(--line);border-radius:16px;box-shadow:0 24px 60px -28px rgb(0 0 0 / .45)}
.signin h1{font-size:1.35rem}
.signin .actions{margin:1.25rem 0}
.signin .actions .btn{width:100%;justify-content:center;text-align:center;min-height:2.85rem;border-radius:999px}
.signin > p.muted{font-size:.88rem}
.signin .actions{margin:.75rem 0 1rem}
.signin-status{display:flex;gap:.5rem;align-items:flex-start;margin:.9rem 0 0;padding:.55rem .7rem;border-radius:8px;background:var(--surface);color:var(--muted);font-size:.86rem}
.signin-status strong{color:var(--text);font-weight:600}
.signin-status-icon{flex:none;display:inline-flex;color:var(--danger);margin-top:.12rem}
.signin-status-icon svg{width:1rem;height:1rem}
.signin-help{font-size:.86rem}
.signin-help summary{color:var(--muted);list-style:none;width:fit-content}
.signin-help summary::-webkit-details-marker{display:none}
.signin-help summary:hover{color:var(--text);text-decoration:underline;text-underline-offset:.2em}
.signin-help p{margin:.4rem 0 0}
.signin-empty{display:flex;flex-direction:column;align-items:flex-start;gap:.35rem}
.signin-empty-icon{display:inline-flex;align-items:center;justify-content:center;width:2.5rem;height:2.5rem;border-radius:10px;background:var(--surface);color:var(--text);margin-bottom:.35rem}
.signin-empty-icon svg{width:1.2rem;height:1.2rem}
.signin-empty h1{margin:0}
.signin-empty p{margin:0}
.signin-command{display:flex;align-items:center;justify-content:space-between;gap:.5rem;margin-top:1rem;padding:.35rem .35rem .35rem .8rem;border:1px solid var(--line);border-radius:8px;background:var(--surface)}
.signin-command code{overflow-wrap:anywhere}
body.focus main{max-width:30rem;padding:3rem 1.25rem}
.consent{display:flex;flex-direction:column}
.consent-pair{display:flex;align-items:center;justify-content:center;gap:.5rem;margin-bottom:1.25rem}
.consent-app,.consent-heel{display:inline-grid;place-items:center;width:3.25rem;height:3.25rem;border-radius:14px;flex:none}
.consent-app{background:var(--surface);box-shadow:inset 0 0 0 1px var(--line);font-size:1.35rem;font-weight:600;color:var(--text)}
.consent-heel svg{width:3.25rem;height:3.25rem}
.consent-link{position:relative;display:inline-grid;place-items:center;width:4.5rem;height:1.5rem;background:radial-gradient(circle,var(--border) 1px,transparent 1.5px) center/7px 7px repeat-x}
.consent-shield{display:inline-grid;place-items:center;width:1.6rem;height:1.6rem;border-radius:999px;background:var(--bg);box-shadow:inset 0 0 0 1px var(--line);color:var(--ok)}
.consent-shield svg{width:.95rem;height:.95rem}
.consent-title{text-align:center;font-size:1.4rem;margin:0 0 .4rem}
.consent-sub{text-align:center;margin:0 0 1.25rem;color:var(--muted);font-size:.92rem}
.consent-sub strong{color:var(--text)}
.consent-facts{list-style:none;margin:0 0 1rem;padding:.25rem 1rem;border:1px solid var(--line);border-radius:12px;background:var(--bg)}
.consent-facts li{display:flex;gap:.7rem;align-items:flex-start;padding:.7rem 0;font-size:.9rem}
.consent-facts li + li{border-top:1px solid var(--line)}
.consent-fact-icon{flex:none;display:inline-flex;color:var(--muted);margin-top:.1rem}
.consent-fact-icon svg{width:1.05rem;height:1.05rem}
.consent-actions{display:grid;grid-template-columns:1fr 1fr;gap:.6rem;margin-top:.25rem}
.consent-actions .btn{width:100%}
@media (max-width:26rem){.consent-actions{grid-template-columns:1fr}.consent-actions [data-heel-ceremony]{order:-1}}
.consent-return{text-align:center;font-size:.82rem;margin:.75rem 0 0}
.consent-return strong{color:var(--text)}
.consent-invalid{align-items:center;text-align:center}
.welcome{max-width:40rem;margin:0 auto}
.welcome-head{display:flex;flex-direction:column;align-items:center;text-align:center;gap:.3rem;margin:1rem 0 1.5rem}
.welcome-head h1{margin:.4rem 0 0}
.welcome-head p{margin:0}
.welcome-step-icon{flex:none;display:inline-grid;place-items:center;width:2.25rem;height:2.25rem;border-radius:10px;background:var(--surface);color:var(--text);align-self:flex-start}
.welcome-step-icon svg{width:1.1rem;height:1.1rem}
.welcome .settings-row{justify-content:flex-start}
.welcome-count{font-size:.85rem;margin:.5rem 0 1.25rem;text-align:center}
.welcome-go{text-align:center}
.heel-spin{animation:heel-spin 1s linear infinite}
@keyframes heel-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.heel-spin{animation:none}}
@media (max-width:36rem){.auth{padding-top:4.5rem}.auth-dog{font-size:9px}.signin{padding:1.4rem 1.25rem;border-radius:14px}}
.nav-icon{display:inline-flex;flex:none}
@media (max-width:55.99rem){
  body.app{padding-bottom:calc(4.4rem + env(safe-area-inset-bottom))}
  body.app > .site{padding:.8rem 1rem .25rem;flex-wrap:nowrap}
  body.app > .site .account{display:none}
  body.app > .site nav{position:fixed;left:0;right:0;bottom:0;z-index:30;max-width:none;padding:.3rem .4rem calc(.3rem + env(safe-area-inset-bottom));background:color-mix(in srgb,var(--bg) 90%,transparent);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-top:1px solid var(--line)}
  body.app > .site nav ul{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:0;margin:0}
  body.app > .site nav li.nav-wide{display:none}
  body.app > .site nav ul > li > a,.nav-more > details > summary{position:relative;display:flex;flex-direction:column;align-items:center;gap:.2rem;padding:.4rem .2rem .3rem;border-radius:10px;font-size:.68rem;line-height:1.1;color:var(--muted);background:none;box-shadow:none;list-style:none;cursor:pointer;white-space:nowrap}
  .nav-more > details > summary::-webkit-details-marker{display:none}
  body.app > .site nav ul > li > a[aria-current="page"],.nav-more > details > summary[aria-current="page"]{color:var(--text);font-weight:600;background:none;box-shadow:none}
  body.app > .site nav ul > li > a:hover{background:none}
  body.app > .site .nav-icon svg{width:1.35rem;height:1.35rem}
  body.app > .site .nav-count{position:absolute;top:.1rem;left:calc(50% + .3rem);margin:0;min-width:1.15rem;padding:0 .3rem;font-size:.62rem;line-height:1.15rem}
  .nav-more-panel{position:absolute;right:.5rem;bottom:calc(100% + .5rem);width:min(16rem,calc(100vw - 1rem));padding:.4rem;border:1px solid var(--line);border-radius:14px;background:var(--bg);box-shadow:0 -12px 36px -16px rgb(0 0 0 / .35)}
  .nav-more-who{margin:0;padding:.45rem .6rem .35rem;color:var(--muted);font-size:.8rem}
  .site .nav-more-panel a,.nav-more-signout{display:flex;align-items:center;gap:.65rem;width:100%;padding:.6rem;border-radius:8px;color:var(--text);font:inherit;font-size:.92rem;text-decoration:none;background:none;border:0;cursor:pointer;text-align:left}
  .site .nav-more-panel a:hover,.nav-more-signout:hover,.site .nav-more-panel a[aria-current="page"]{background:var(--surface);box-shadow:none;font-weight:600}
  .nav-more-panel form{margin:0;border-top:1px solid var(--line);margin-top:.25rem;padding-top:.25rem}
  .nav-more-panel .nav-icon svg{width:1.1rem;height:1.1rem}
  .subnav ul{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none}
  #heel-ceremony-status:not(:empty){bottom:calc(4.8rem + env(safe-area-inset-bottom))}
}
.nav-count{display:inline-block;min-width:1.35rem;margin-left:.3rem;padding:0 .4rem;border-radius:999px;background:var(--accent);color:var(--accent-text);font-size:.72rem;font-weight:700;line-height:1.35rem;text-align:center;vertical-align:1px}
@media (min-width:56rem){
  body.app{display:grid;grid-template-columns:15rem minmax(0,1fr);grid-template-rows:auto 1fr;min-height:100vh}
  body.app > .site{grid-column:1;grid-row:1 / span 2;position:sticky;top:0;height:100vh;max-width:none;margin:0;padding:1.1rem .9rem;flex-direction:column;flex-wrap:nowrap;align-items:stretch;gap:1.25rem;background:color-mix(in srgb,var(--bg) 70%,transparent);border-right:1px solid var(--line);backdrop-filter:blur(6px)}
  body.app > .site .brand{padding:0 .55rem}
  body.app > .site nav ul{flex-direction:column;flex-wrap:nowrap;gap:.15rem}
  body.app > .site nav a{display:flex;align-items:center;gap:.6rem;width:100%;padding:.45rem .6rem;font-size:.93rem}
  body.app > .site .nav-icon svg{width:1.05rem;height:1.05rem}
  .nav-more{display:none}
  body.app > .site nav .nav-count{margin-left:auto}
  body.app > .site .account{margin:auto 0 0;flex-direction:column;align-items:flex-start;gap:.35rem;padding:.75rem .55rem 0;border-top:1px solid var(--line)}
  body.app > .site .sign-out{padding:.3rem 0}
  body.app > .banner{grid-column:2;grid-row:1}
  body.app > main{grid-column:2;grid-row:2;width:100%;padding:2rem 2.25rem}
}
[role="status"]:empty{display:none}
#heel-ceremony-status:not(:empty){position:fixed;left:1rem;right:1rem;bottom:1rem;max-width:56rem;margin:0 auto;z-index:20;padding:.75rem 1rem;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:12px;box-shadow:0 10px 30px -12px rgb(0 0 0 / .35);overflow-wrap:anywhere}
body:has(#heel-ceremony-status:not(:empty)) main{padding-bottom:10rem}
`;

/** The full stylesheet for every human-plane page. */
/**
 * heel's own rules sit in the `heel` layer, under Tailwind's `utilities`, so
 * a shadcn/ui component's classes win where it sets them (theme: palette
 * variables stay unlayered, so the shadcn tokens resolve to them).
 */
export const STYLESHEET = [
  "@layer properties, theme, heel, components, utilities;",
  `:root{${variables(LIGHT)}}`,
  `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${variables(DARK)}}}`,
  `:root[data-theme="dark"]{${variables(DARK)}}`,
  `@layer heel{${[RULES, HOME_CSS, APPROVALS_CSS, CONNECTIONS_CSS, ACTIVITY_CSS, RULES_CSS, AGENTS_CSS, SETTINGS_CSS].join("\n")}}`,
  TAILWIND_CSS,
].join("\n");

/** Exposed for the contrast test, which checks each pair the pages use. */
export const PALETTES = { light: LIGHT, dark: DARK } as const;
