import { html as honoHtml, raw as honoRaw } from "hono/html";

/**
 * Markup the human plane renders. Node runs heel's TypeScript by stripping
 * types, and type stripping doesn't transform JSX, so components are Hono
 * `html` templates in plain `.ts` files rather than `.tsx`. Hono escapes every
 * interpolated string, so agent-supplied text (arguments, subjects, rule
 * names) can never become markup.
 */
export type Html = Exclude<ReturnType<typeof honoHtml>, Promise<unknown>>;

/**
 * What a template may interpolate. Narrower than Hono's `unknown` on purpose:
 * an object would render as `[object Object]`, and a promise would make the
 * whole page asynchronous. `false`, `null` and `undefined` render nothing.
 */
export type Child = string | number | boolean | null | undefined | Html | readonly Child[];

/** Hono's `html`, typed to the children above and guaranteed synchronous. */
export function html(strings: TemplateStringsArray, ...values: Child[]): Html {
  const out = honoHtml(strings, ...values);
  if (out instanceof Promise) {
    throw new TypeError("heel UI renders synchronously; a template produced a promise");
  }
  return out;
}

/**
 * Trusted markup, inserted unescaped. Only for strings heel itself wrote
 * (the stylesheet, the client script), never for anything a request carried.
 */
export function trusted(markup: string): Html {
  return honoRaw(markup);
}

/** A boolean attribute such as `disabled`: present or absent, never `="false"`. */
export function flag(
  name: "disabled" | "checked" | "selected" | "open" | "required",
  on: boolean,
): Html | "" {
  return on ? trusted(` ${name}`) : "";
}

/** Renders a page or fragment to the string a response sends. */
export function toHtmlString(markup: Html): string {
  return markup.toString();
}
