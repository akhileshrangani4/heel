import { describe, expect, it } from "vitest";
import { createPreviewApp } from "../../src/web/ui/preview/app.ts";
import {
  COMPONENTS,
  findStory,
  REQUIRED_STATES,
  renderStory,
  STORIES,
} from "../../src/web/ui/preview/stories.ts";
import { accessibleName, dom, interactiveControls, text } from "../helpers/dom.ts";

const THEMES = ["light", "dark"] as const;

describe("UI preview harness", () => {
  it("has a story for every component in every required state", () => {
    const missing = COMPONENTS.flatMap((c) =>
      REQUIRED_STATES.filter((state) => findStory(c.id, state) === undefined).map(
        (state) => `${c.id}/${state}`,
      ),
    );
    expect(missing).toEqual([]);
  });

  it("has no duplicate stories", () => {
    const keys = STORIES.map((s) => `${s.component}/${s.state}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("serves every story in both themes, and an index linking to each", async () => {
    const app = createPreviewApp();
    const index = await app.request("/");
    expect(index.status).toBe(200);
    const links = new Set(
      [...dom(await index.text()).querySelectorAll("a[href]")].map((a) => a.getAttribute("href")),
    );
    for (const story of STORIES) {
      for (const theme of THEMES) {
        const href = `/${story.component}/${story.state}?theme=${theme}`;
        expect(links.has(href), href).toBe(true);
        const res = await app.request(href);
        expect(res.status, href).toBe(200);
        expect(res.headers.get("content-type")).toMatch(/^text\/html/);
        const doc = dom(await res.text());
        expect(doc.documentElement.getAttribute("data-theme")).toBe(theme);
      }
    }
  });

  it("returns 404 for an unknown story", async () => {
    const res = await createPreviewApp().request("/approval-request/nope");
    expect(res.status).toBe(404);
  });

  describe.each(STORIES.map((s) => [`${s.component}/${s.state}`, s] as const))(
    "%s",
    (_key, story) => {
      const doc = dom(renderStory(story, "light"));

      it("renders one page heading and a language", () => {
        expect(doc.querySelectorAll("main h1")).toHaveLength(1);
        expect(text(doc.querySelector("main h1"))).not.toBe("");
        expect(doc.documentElement.getAttribute("lang")).toBe("en");
      });

      it("labels every control", () => {
        const unnamed = interactiveControls(doc)
          .filter((control) => accessibleName(control, doc) === "")
          .map((control) => control.outerHTML.slice(0, 120));
        expect(unnamed).toEqual([]);
      });

      it("never repeats an id", () => {
        const ids = [...doc.querySelectorAll("[id]")].map((el) => el.getAttribute("id"));
        expect(ids.length - new Set(ids).size).toBe(0);
      });

      it("points every aria reference at an element that exists", () => {
        const dangling = [...doc.querySelectorAll("[aria-describedby], [aria-labelledby]")].flatMap(
          (el) =>
            `${el.getAttribute("aria-describedby") ?? ""} ${el.getAttribute("aria-labelledby") ?? ""}`
              .split(/\s+/)
              .filter((id) => id !== "" && doc.getElementById(id) === null),
        );
        expect(dangling).toEqual([]);
      });

      it("shows a load or render error as an alert", () => {
        if (story.state !== "error" && story.state !== "load-error") return;
        expect(doc.querySelector("main [role=alert]")).not.toBeNull();
      });
    },
  );

  it("I-56: preview handlers only announce a ceremony and post nothing", () => {
    const story = findStory("approval-request", "pending");
    if (!story) throw new Error("missing story");
    const script = [...dom(renderStory(story, "light")).querySelectorAll("script")]
      .map((s) => s.textContent ?? "")
      .join("\n");
    expect(script).not.toMatch(
      /fetch\(|XMLHttpRequest|\.submit\(|sendBeacon|navigator\.credentials/,
    );
    expect(script).toContain("Nothing was decided.");
  });

  it("sign-in screens show no navigation and no pause, even when a pause is set", () => {
    for (const component of ["sign-in-oidc", "sign-in-passkey"] as const) {
      const story = findStory(component, "paused");
      if (!story) throw new Error(`missing ${component}/paused`);
      expect(story.pause).not.toBeNull();
      const doc = dom(renderStory(story, "dark"));
      expect(doc.querySelector("nav")).toBeNull();
      expect(doc.querySelector(".banner")).toBeNull();
      expect(text(doc)).not.toMatch(/inbox-bot/);
    }
  });
});
