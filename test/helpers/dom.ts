import { parseHTML } from "linkedom";
import { type Html, toHtmlString } from "../../src/web/ui/html.ts";

/*
 * The repo compiles against Node's globals only (`lib: ["esnext"]`), so server
 * code can't reach for `document` by accident. Rather than pull the DOM lib
 * into the whole program for the tests, these are the few DOM shapes the UI
 * tests read, which linkedom's parsed tree satisfies.
 */

/** A live list of matched elements: indexable, iterable, with a length. */
export type UiList = ArrayLike<UiElement> & Iterable<UiElement>;

export interface UiElement {
  readonly tagName: string;
  readonly outerHTML: string;
  readonly textContent: string | null;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  closest(selectors: string): UiElement | null;
  querySelector(selectors: string): UiElement | null;
  querySelectorAll(selectors: string): UiList;
}

export interface UiDocument {
  readonly documentElement: UiElement;
  readonly body: UiElement;
  getElementById(id: string): UiElement | null;
  querySelector(selectors: string): UiElement | null;
  querySelectorAll(selectors: string): UiList;
}

/** Parses rendered markup into a DOM the tests can query like a browser would. */
export function dom(markup: Html | string): UiDocument {
  const source = typeof markup === "string" ? markup : toHtmlString(markup);
  // A fragment still gets a full document, with the fragment in <body>.
  const wrapped = /^\s*<!doctype/i.test(source)
    ? source
    : `<!doctype html><html><body>${source}</body></html>`;
  return parseHTML(wrapped).document as unknown as UiDocument;
}

/** Text with whitespace runs collapsed, as a reader would see it. */
export function text(node: UiElement | UiDocument | null): string {
  if (node === null) return "";
  const root = "body" in node ? node.body : node;
  return (root.textContent ?? "").replace(/\s+/g, " ").trim();
}

/**
 * The accessible name of a control, following the parts of the name
 * computation the UI relies on: aria-labelledby, aria-label, a `<label for>`,
 * a wrapping `<label>`, then (for buttons and links) the visible text.
 */
export function accessibleName(control: UiElement, doc: UiDocument): string {
  const labelledBy = control.getAttribute("aria-labelledby");
  if (labelledBy) {
    return labelledBy
      .split(/\s+/)
      .map((id) => text(doc.getElementById(id)))
      .join(" ")
      .trim();
  }
  const ariaLabel = control.getAttribute("aria-label");
  if (ariaLabel) return ariaLabel.trim();
  const id = control.getAttribute("id");
  if (id) {
    const label = [...doc.querySelectorAll("label")].find((l) => l.getAttribute("for") === id);
    if (label) return text(label);
  }
  const wrapping = control.closest("label");
  if (wrapping) return text(wrapping);
  const tag = control.tagName.toLowerCase();
  if (tag === "button" || tag === "a" || tag === "summary") return text(control);
  return "";
}

/** Controls a person can operate: everything that must have a name. */
export function interactiveControls(doc: UiDocument): UiElement[] {
  return [...doc.querySelectorAll("button, a[href], select, textarea, input:not([type=hidden])")];
}
