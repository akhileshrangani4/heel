import { type Child, type Html, html, trusted } from "./html.ts";
import { X_ICON } from "./icons.ts";
import { btn } from "./shadcn/button.ts";

/**
 * A shadcn-style dialog on the browser's own <dialog>: a button opens it
 * (showModal, so focus is trapped and Escape closes it), a close button and a
 * click on the backdrop close it. With no script the button does nothing, so
 * pages that need to work without script link to an anchor in `fallbackHref`.
 */
export function dialogTrigger(props: { dialogId: string; label: Child; className?: string }): Html {
  return html`<button type="button" class="${props.className ?? btn()}" aria-haspopup="dialog" aria-controls="${props.dialogId}" onclick="document.getElementById('${props.dialogId}').showModal()">${props.label}</button>`;
}

export function dialog(props: {
  id: string;
  title: string;
  description?: Child;
  body: Html;
  /** Wider for grids (the service picker). */
  wide?: boolean;
}): Html {
  const titleId = `${props.id}-title`;
  return html`<dialog id="${props.id}" class="ui-dialog${props.wide ? " ui-dialog-wide" : ""}" aria-labelledby="${titleId}" onclick="if (event.target === this) this.close()">
    <div class="ui-dialog-panel">
      <div class="ui-dialog-head">
        <h2 id="${titleId}" class="ui-dialog-title">${props.title}</h2>
        <button type="button" class="${btn("ghost", "icon-sm")} ui-dialog-close" aria-label="Close" onclick="this.closest('dialog').close()">${trusted(X_ICON)}</button>
      </div>
      ${props.description === undefined ? "" : html`<p class="ui-dialog-desc muted">${props.description}</p>`}
      ${props.body}
    </div>
  </dialog>`;
}
