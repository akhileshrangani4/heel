import { type Html, html } from "./html.ts";

/**
 * The shadcn/ui Switch look for a control that already exists: a track with
 * a sliding thumb, then the state in words beside it ("Running", "Paused"),
 * so the state never rests on the thumb's position or colour alone. The
 * caller owns the element (a submit button in a form, or a passkey ceremony
 * button) and puts `role="switch"` and `aria-checked` on it; this is only the
 * inside of that button.
 */
export function switchFace(on: boolean, word: string): Html {
  return html`<span class="ui-switch-track" data-on="${on ? "true" : "false"}" aria-hidden="true"><span class="ui-switch-thumb"></span></span><span class="ui-switch-word">${word}</span>`;
}
