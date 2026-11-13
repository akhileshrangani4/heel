import { flag, type Html, html, trusted } from "./html.ts";

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
export type CeremonyIntent = "approve-once" | "approve-standing" | "deny" | "resume" | "sign-in";

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
}

/** `approvalId` → `data-approval-id`. */
function dataAttribute(key: string): string {
  return `data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/** Binding keys become attribute names, so only plain identifiers are allowed. */
const BINDING_KEY = /^[a-z][A-Za-z0-9]*$/;

export function ceremonyButton(props: CeremonyButtonProps): Html {
  const bindings = Object.entries(props.binding).map(([key, value]) => {
    if (!BINDING_KEY.test(key)) throw new TypeError(`invalid ceremony binding key: ${key}`);
    return html` ${trusted(dataAttribute(key))}="${value}"`;
  });
  return html`<button
    type="button"
    class="btn btn-${props.tone}"
    data-heel-ceremony="${props.intent}"
    data-heel-handler="${props.callback.handler}"${bindings}${
      props.optionsFrom ? html` data-heel-options="${props.optionsFrom}"` : ""
    }${props.describedBy ? html` aria-describedby="${props.describedBy}"` : ""}${flag(
      "disabled",
      props.disabled ?? false,
    )}
  >
    ${props.label}
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
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const button = target ? target.closest("button[data-heel-ceremony]") : null;
    if (!button || button.disabled) return;
    const registry = window.heelCeremony || {};
    const name = button.dataset.heelHandler;
    const handler = Object.hasOwn(registry, name) ? registry[name] : undefined;
    if (typeof handler !== "function") {
      const region = status();
      if (region) region.textContent = "Passkey check isn't available on this page yet. Nothing was decided.";
      return;
    }
    const options = {};
    const fieldset = button.dataset.heelOptions ? document.getElementById(button.dataset.heelOptions) : null;
    if (fieldset) {
      for (const input of fieldset.querySelectorAll("input:checked, select")) options[input.name] = input.value;
    }
    const binding = { ...button.dataset };
    delete binding.heelCeremony;
    delete binding.heelHandler;
    delete binding.heelOptions;
    handler({ intent: button.dataset.heelCeremony, binding, options, status: status() });
  });
})();
`;
