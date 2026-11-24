import { flag, type Html, html, trusted } from "./html.ts";
import { btn } from "./shadcn/button.ts";

/**
 * Decision controls never decide. Every decision (approve once, approve as
 * standing, deny, resume) needs a fresh passkey assertion whose challenge is
 * bound to the approval id and call hash (I-56; spec: The approval page). So
 * a decision control is a plain `type="button"` outside any form: clicking it
 * calls the client-side handler named by the component's `CeremonyCallback`
 * prop, and that handler runs the WebAuthn ceremony and posts the assertion.
 * With no handler registered, the click does nothing but say so.
 *
 * A server-rendered page can't carry a function, so the prop names the
 * handler; the page script registers it on `window.heelCeremony`.
 */
export interface CeremonyCallback {
  /** Key of the handler on `window.heelCeremony`, e.g. `"decide"`. */
  readonly handler: string;
}

/** What a ceremony is for; the handler receives it as `intent`. */
export type CeremonyIntent =
  | "approve-once"
  | "approve-standing"
  | "deny"
  | "resume"
  | "sign-in"
  | "enroll"
  | "connect"
  | "mode"
  | "grant"
  | "add-device"
  | "apply-rules"
  | "manage-agent"
  | "manage-account"
  | "manage-people"
  | "save-rules";

export interface CeremonyButtonProps {
  callback: CeremonyCallback;
  intent: CeremonyIntent;
  label: string;
  tone: "primary" | "secondary" | "danger";
  /** Bound into the challenge: e.g. `approvalId` and `callHash`. Sent as `data-*`. */
  binding: Readonly<Record<string, string>>;
  disabled?: boolean;
  /** Id of the text that explains the button, e.g. "a passkey is required". */
  describedBy?: string;
  /** Id of a fieldset whose inputs the handler reads (the standing-approval options). */
  optionsFrom?: string;
  /** Id of a status line beside the button; progress and errors go there instead of the page's. */
  statusId?: string;
  /** A small icon drawn before the label (trusted SVG markup). */
  icon?: string;
  /**
   * Draw the button as a switch (Settings, Pause): `role="switch"` with its
   * state, `label` as the state in words beside the track, and `ariaLabel`
   * naming what it switches.
   */
  asSwitch?: { checked: boolean; ariaLabel: string };
  /** Draw the button as one segment of a segmented control (Modes), named by `ariaLabel`. */
  asSegment?: { ariaLabel: string };
}

/** lucide's key-round, for the passkey sign-in button. */
export const KEY_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/></svg>`;

/** `approvalId` → `data-approval-id`. */
function dataAttribute(key: string): string {
  return `data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/** Binding keys become attribute names, so only plain identifiers are allowed. */
const BINDING_KEY = /^[a-z][A-Za-z0-9]*$/;

/** heel's three button tones, as shadcn/ui Button variants. */
const TONE_VARIANT = { primary: "default", secondary: "outline", danger: "danger" } as const;

export function ceremonyButton(props: CeremonyButtonProps): Html {
  const bindings = Object.entries(props.binding).map(([key, value]) => {
    if (!BINDING_KEY.test(key)) throw new TypeError(`invalid ceremony binding key: ${key}`);
    return html` ${trusted(dataAttribute(key))}="${value}"`;
  });
  const sw = props.asSwitch;
  return html`<button
    type="button"
    class="${sw ? "ui-switch" : props.asSegment ? "seg-item" : btn(TONE_VARIANT[props.tone])}"${
      props.asSegment ? html` aria-label="${props.asSegment.ariaLabel}"` : ""
    }${
      sw
        ? html` role="switch" aria-checked="${sw.checked ? "true" : "false"}" aria-label="${sw.ariaLabel}"`
        : ""
    }
    data-heel-ceremony="${props.intent}"
    data-heel-handler="${props.callback.handler}"${bindings}${
      props.optionsFrom ? html` data-heel-options="${props.optionsFrom}"` : ""
    }${props.statusId ? html` data-heel-status="${props.statusId}"` : ""}${
      props.describedBy ? html` aria-describedby="${props.describedBy}"` : ""
    }${flag("disabled", props.disabled ?? false)}
  >
    ${
      sw
        ? html`<span class="ui-switch-track" data-on="${sw.checked ? "true" : "false"}" aria-hidden="true"><span class="ui-switch-thumb"></span></span><span class="ui-switch-word">${props.label}</span>`
        : html`${props.icon ? trusted(props.icon) : ""}${props.label}`
    }
  </button>`;
}

/**
 * The one client script decision pages need: delegate clicks on ceremony
 * buttons to the registered handler, passing the bound data and any options.
 * It only reads the page and calls the handler; it never posts anything.
 */
export const CEREMONY_SCRIPT = `
(() => {
  const status = () => document.getElementById("heel-ceremony-status");
  // Handlers may write the outcome later (after the passkey prompt). The page-wide
  // message is pinned to the viewport bottom, so bring the button that started it
  // to the middle of the screen, clear of the message. A button in an action bar
  // writes to the bar's own one-line slot instead, and nothing scrolls.
  let lastButton = null;
  const region = status();
  if (region) {
    new MutationObserver(() => {
      if (lastButton && region.textContent && !lastButton.closest("[data-heel-bar]")) lastButton.scrollIntoView({ block: "center" });
    }).observe(region, { childList: true, characterData: true, subtree: true });
  }
  // A one-line slot: messages longer than the slot are cut, whole in the tooltip.
  const oneLine = (slot) => {
    const full = slot.textContent;
    slot.title = full;
    const fit = Math.max(12, Math.floor(slot.clientWidth / 6.5));
    if (full.length > fit) slot.textContent = full.slice(0, fit - 1).trimEnd() + "…";
  };
  // Each ceremony button is in one state: idle, waiting, success, error or
  // cancelled. Its label never changes, so it never changes size: waiting and
  // success draw an icon over the hidden label, in the same box.
  const SPIN = '<svg class="heel-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>';
  const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  const setState = (button, state) => {
    // The icon keeps the label's own colour while the label is hidden.
    if (!button.style.getPropertyValue("--heel-btn-fg")) button.style.setProperty("--heel-btn-fg", getComputedStyle(button).color);
    button.dataset.heelState = state;
    const busy = state === "waiting" || state === "success";
    button.disabled = busy;
    if (busy) button.setAttribute("aria-busy", "true");
    else button.removeAttribute("aria-busy");
    let icon = button.querySelector(":scope > .heel-btn-icon");
    if (!icon) {
      icon = document.createElement("span");
      icon.className = "heel-btn-icon";
      icon.setAttribute("aria-hidden", "true");
      button.append(icon);
    }
    icon.innerHTML = state === "waiting" ? SPIN : state === "success" ? CHECK : "";
  };
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const button = target ? target.closest("button[data-heel-ceremony]") : null;
    if (!button || button.disabled) return;
    lastButton = button;
    const registry = window.heelCeremony || {};
    const name = button.dataset.heelHandler;
    const handler = Object.hasOwn(registry, name) ? registry[name] : undefined;
    if (typeof handler !== "function") {
      if (region) region.textContent = "Passkey check isn't available on this page yet. Nothing was decided.";
      return;
    }
    const options = {};
    const fieldset = button.dataset.heelOptions ? document.getElementById(button.dataset.heelOptions) : null;
    if (fieldset) {
      for (const input of fieldset.querySelectorAll("input:checked, select, textarea, input:not([type=radio]):not([type=checkbox])")) options[input.name] = input.value;
    }
    const binding = { ...button.dataset };
    delete binding.heelCeremony;
    delete binding.heelHandler;
    delete binding.heelOptions;
    delete binding.heelStatus;
    const own = button.dataset.heelStatus ? document.getElementById(button.dataset.heelStatus) : null;
    const bar = button.closest("[data-heel-bar]");
    const slot = own || (bar && bar.querySelector("[data-heel-bar-status]")) || status();
    // The bar's slot holds one line: watch it and keep it to one line.
    let watch = null;
    if (slot && bar && slot !== region) {
      watch = new MutationObserver(() => { watch.disconnect(); oneLine(slot); watch.observe(slot, { childList: true, characterData: true, subtree: true }); });
      watch.observe(slot, { childList: true, characterData: true, subtree: true });
    }
    const result = handler({ intent: button.dataset.heelCeremony, binding, options, status: slot });
    // Handlers resolve to "success", "error" or "cancelled" (client.ts, run).
    if (result && typeof result.then === "function") {
      setState(button, "waiting");
      const done = (outcome) => {
        if (outcome === "success") {
          // The page is moving on; if it doesn't within a few seconds, let the person try again.
          setState(button, "success");
          setTimeout(() => setState(button, "idle"), 4000);
        } else {
          setState(button, outcome === "cancelled" ? "cancelled" : "error");
        }
        if (slot) slot.dataset.tone = outcome === "success" ? "ok" : outcome === "cancelled" ? "muted" : "error";
      };
      result.then((outcome) => done(outcome || "success"), () => done("error"));
    } else if (result === "error") {
      setState(button, "error");
      if (slot) slot.dataset.tone = "error";
    }
  });
  // Copy buttons (presentation only; they decide nothing): copy the text of the element they name.
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("button[data-heel-copy]") : null;
    const source = target ? document.getElementById(target.dataset.heelCopy) : null;
    if (!source || !navigator.clipboard) return;
    navigator.clipboard.writeText(source.textContent.trim()).then(() => {
      const before = target.textContent;
      target.textContent = "Copied";
      setTimeout(() => { target.textContent = before; }, 1500);
    }, () => {});
  });
})();
`;
