import { Hono } from "hono";
import { html, toHtmlString } from "../html.ts";
import { page, type Theme } from "../layout.ts";
import { COMPONENTS, findStory, renderStory, STORIES } from "./stories.ts";

/**
 * The preview harness: every story at `/<component>/<state>?theme=light|dark`
 * and an index at `/`. It renders fixture props only and holds no state, so
 * it never touches a store, vault or session. `heel serve` never mounts it;
 * `pnpm ui:preview` runs it on its own loopback port.
 */

function parseTheme(value: string | undefined): Theme {
  return value === "light" || value === "dark" ? value : "auto";
}

function index(): string {
  const groups = COMPONENTS.map((component) => {
    const stories = STORIES.filter((s) => s.component === component.id);
    return html`<section aria-labelledby="c-${component.id}">
      <h2 id="c-${component.id}">${component.name}</h2>
      <table class="data">
        <caption>
          ${component.name} states
        </caption>
        <thead>
          <tr>
            <th scope="col">State</th>
            <th scope="col">What it shows</th>
            <th scope="col">Light</th>
            <th scope="col">Dark</th>
          </tr>
        </thead>
        <tbody>
          ${stories.map((s) => {
            const href = `/${s.component}/${s.state}`;
            return html`<tr>
              <th scope="row" class="mono">${s.state}</th>
              <td>${s.label}</td>
              <td><a href="${href}?theme=light">${component.name} ${s.state}, light</a></td>
              <td><a href="${href}?theme=dark">${component.name} ${s.state}, dark</a></td>
            </tr>`;
          })}
        </tbody>
      </table>
    </section>`;
  });
  return toHtmlString(
    page({
      title: "UI preview",
      viewer: null,
      body: html`<h1>heel UI preview</h1>
        <p class="muted">Fixture props only. Decision buttons announce the passkey ceremony they would start and decide nothing.</p>
        ${groups}`,
    }),
  );
}

export function createPreviewApp(): Hono {
  const app = new Hono();
  app.get("/", (c) => c.html(index()));
  app.get("/:component/:state", (c) => {
    const story = findStory(c.req.param("component"), c.req.param("state"));
    if (!story) return c.text("no such story", 404);
    return c.html(toHtmlString(renderStory(story, parseTheme(c.req.query("theme")))));
  });
  return app;
}
