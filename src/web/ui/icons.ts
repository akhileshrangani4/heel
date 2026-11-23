/**
 * lucide icons and small inline behaviours used on more than one page. Each
 * icon is decorative (aria-hidden); the text beside it carries the meaning.
 */

/** chevron-down, turned when its fold opens (`details[open] > summary .chev`). */
export const CHEVRON_DOWN = `<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;

/** chevron-right, for rows that open a page. */
export const CHEVRON_RIGHT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>`;

/** ellipsis, for the "more" button that opens a row's manage panel. */
export const ELLIPSIS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>`;

/** x, for closing a dialog or removing a filter. */
export const X_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;

/** Submits a control's form as soon as it changes; a no-script Submit button covers the rest. */
export const APPLY_ON_CHANGE =
  "this.form.requestSubmit ? this.form.requestSubmit() : this.form.submit()";
