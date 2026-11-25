import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { html, toHtmlString, trusted } from "../html.ts";
import type { Theme } from "../layout.ts";
import { ALL_STORIES, COMPONENTS, findStory, PAGES, renderStory } from "./stories.ts";

/**
 * The preview harness: every story at `/<component>/<state>?theme=light|dark`
 * and an index at `/`. It renders fixture props only and holds no state, so
 * it never touches a store, vault or session. `heel serve` never mounts it;
 * `pnpm ui:preview` runs it on its own loopback port.
 */

function parseTheme(value: string | undefined): Theme {
  return value === "light" || value === "dark" ? value : "auto";
}

/** Gallery styles: the index is a contact sheet of every story, not a heel page. */
const GALLERY_CSS = `
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:#f4f4f2;color:#18181b}
.bar{position:sticky;top:0;z-index:10;display:flex;flex-wrap:wrap;align-items:center;gap:.4rem 1rem;padding:.6rem 1.25rem;background:rgb(255 255 255 / .92);backdrop-filter:blur(8px);border-bottom:1px solid #e4e4e7}
.bar h1{font-size:1rem;margin:0 .5rem 0 0}
.bar nav{display:flex;flex-wrap:wrap;gap:.15rem .5rem;flex:1}
.bar nav a{color:#52525b;text-decoration:none;font-size:.82rem;padding:.15rem .4rem;border-radius:6px}
.bar nav a:hover{background:#f4f4f5;color:#18181b}
.bar label{display:flex;align-items:center;gap:.35rem;font-size:.82rem;color:#52525b;cursor:pointer;white-space:nowrap}
main{padding:1rem 1.25rem 3rem}
section{margin:0 0 2rem}
section > h2{font-size:1.15rem;margin:1.5rem 0 .75rem;scroll-margin-top:4rem}
.row{display:flex;flex-wrap:wrap;gap:1rem;align-items:flex-start;padding:1rem;margin:0 0 .75rem;background:#fff;border:1px solid #e4e4e7;border-radius:12px}
.meta{width:13rem;flex:none}
.meta .state{font:600 .85rem ui-monospace,SFMono-Regular,Menlo,monospace}
.meta p{margin:.25rem 0 .5rem;color:#52525b;font-size:.82rem}
.meta .links{display:flex;gap:.6rem;font-size:.75rem}
.meta .links a{color:#71717a}
.shots{display:flex;flex-wrap:wrap;gap:.9rem;align-items:flex-start}
.shot{display:block;text-decoration:none;color:#71717a;font-size:.72rem}
.frame{display:block;position:relative;overflow:hidden;border:1px solid #e4e4e7;border-radius:8px;background:#fff;box-shadow:0 1px 3px rgb(0 0 0 / .06)}
.frame iframe{position:absolute;top:0;left:0;border:0;transform-origin:0 0;pointer-events:none}
.shot:hover .frame{border-color:#a1a1aa;box-shadow:0 4px 14px -6px rgb(0 0 0 / .25)}
.desk .frame{width:512px;height:320px}
.desk iframe{width:1280px;height:800px;transform:scale(.4)}
.phone .frame{width:176px;height:380px;border-radius:14px}
.phone iframe{width:390px;height:844px;transform:scale(.45)}
.dark .frame{background:#0f0f10}
.cap{display:block;margin-top:.3rem}
body.no-dark .dark{display:none}
`;

function thumb(href: string, kind: "desk" | "phone", theme: "light" | "dark", label: string) {
  const src = `${href}?theme=${theme}&thumb=1`;
  const cls = `shot ${kind}${theme === "dark" ? " dark" : ""}`;
  return html`<a class="${cls}" href="${href}?theme=${theme}" target="_blank" rel="noopener" title="Open ${label}">
    <span class="frame"><iframe src="${src}" loading="lazy" tabindex="-1" title="${label}"></iframe></span>
    <span class="cap">${label}</span>
  </a>`;
}

function index(): string {
  const components = [...PAGES, ...COMPONENTS];
  const groups = components.map((component) => {
    const stories = ALL_STORIES.filter((s) => s.component === component.id);
    return html`<section aria-labelledby="c-${component.id}">
      <h2 id="c-${component.id}">${component.name}</h2>
      ${stories.map((s) => {
        const href = `/${s.component}/${s.state}`;
        return html`<div class="row">
          <div class="meta">
            <div class="state">${s.state}</div>
            <p>${s.label}</p>
            <div class="links">
              <a href="${href}?theme=light">${component.name} ${s.state}, light</a>
              <a href="${href}?theme=dark">${component.name} ${s.state}, dark</a>
            </div>
          </div>
          <div class="shots">
            ${thumb(href, "desk", "light", "Desktop, light")}
            ${thumb(href, "phone", "light", "Phone, light")}
            ${thumb(href, "phone", "dark", "Phone, dark")}
          </div>
        </div>`;
      })}
    </section>`;
  });
  return toHtmlString(html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>UI preview · heel</title>
    <style>${trusted(GALLERY_CSS)}</style>
  </head>
  <body>
    <header class="bar">
      <h1>heel UI preview</h1>
      <nav aria-label="Components">
        ${components.map((c) => html`<a href="#c-${c.id}">${c.name}</a>`)}
      </nav>
      <label><input type="checkbox" checked onchange="document.body.classList.toggle('no-dark', !this.checked)" /> Dark thumbnails</label>
    </header>
    <main>
      <p style="color:#52525b;margin:0">Fixture props only. Click any thumbnail to open it full size. Decision buttons announce the passkey ceremony they would start and decide nothing.</p>
      ${groups}
    </main>
  </body>
</html>`);
}

export function createPreviewApp(): Hono {
  const app = new Hono();
  app.get("/", (c) => c.html(index()));
  // The favicon, so the harness can show the waiting dot drawn over it.
  app.get("/icon-180.png", (c) =>
    c.body(
      new Uint8Array(
        readFileSync(new URL("../../../../assets/logo/heel-icon-180.png", import.meta.url)),
      ),
      200,
      { "content-type": "image/png" },
    ),
  );
  app.get("/:component/:state", (c) => {
    const story = findStory(c.req.param("component"), c.req.param("state"));
    if (!story) return c.text("no such story", 404);
    const banner = c.req.query("banner");
    const mode = banner === "everywhere" || banner === "elsewhere" ? banner : undefined;
    return c.html(toHtmlString(renderStory(story, parseTheme(c.req.query("theme")), mode)));
  });
  return app;
}
