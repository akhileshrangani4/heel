import { type Html, html, trusted } from "./html.ts";
import type { FormTarget } from "./layout.ts";

export interface LoopbackSignInProps {
  alias: string;
  /** Google's sign-in page for this sign-in. */
  google: string;
  /** Where a pasted address goes. */
  paste: FormTarget;
  state: string;
  /**
   * heel's approval page isn't on localhost, so heel almost certainly runs on
   * another machine and Google's last page won't load: lead with the paste.
   */
  remote: boolean;
}

/**
 * Paste and finish: reads the copied address from the clipboard and sends it
 * if it's this sign-in's. The server checks it again either way. Without
 * clipboard access (refused, or an older browser) it points at the box.
 */
const PASTE_SCRIPT = `
(() => {
  const button = document.getElementById("paste-finish");
  const form = document.getElementById("paste-form");
  const input = document.getElementById("address");
  const note = document.getElementById("paste-note");
  if (!button || !form || !input || !note) return;
  const state = form.querySelector("input[name=state]").value;
  const looksRight = (text) => /^(https?:\\/\\/)?(127\\.0\\.0\\.1|localhost)[:/]/.test(text) && text.includes("state=" + state);
  const manual = (message) => { note.textContent = message; input.focus(); };
  button.addEventListener("click", async () => {
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      manual("Paste the address in the box below, then choose Finish signing in.");
      return;
    }
    let text = "";
    try { text = (await navigator.clipboard.readText()).trim(); } catch {
      manual("heel couldn't read what you copied. Paste it in the box below, then choose Finish signing in.");
      return;
    }
    if (!looksRight(text)) {
      manual("What you copied isn't the address of Google's last page. Copy the whole address from that tab, starting http://127.0.0.1, and try again.");
      return;
    }
    input.value = text;
    // Older Safari has no requestSubmit; the box is filled, so submit() is safe.
    if (form.requestSubmit) form.requestSubmit(); else form.submit();
  });
})();
`;

function pasteForm(props: LoopbackSignInProps): Html {
  return html`<form id="paste-form" method="post" action="${props.paste.action}" class="paste-form">
    <input type="hidden" name="csrf" value="${props.paste.csrfToken}" />
    <input type="hidden" name="state" value="${props.state}" />
    <p><button type="button" id="paste-finish" class="btn btn-primary">Paste and finish</button></p>
    <p id="paste-note" class="muted" role="status" aria-live="polite"></p>
    <label for="address">Or paste the address here</label>
    <input
      id="address"
      name="address"
      required
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      inputmode="url"
      placeholder="http://127.0.0.1:…/?state=…&code=…"
    />
    <button type="submit" class="btn btn-secondary">Finish signing in</button>
  </form>`;
}

function googleStep(props: LoopbackSignInProps): Html {
  return html`<li>
    <p>Sign in with the Google account for <strong>${props.alias}</strong>, and allow what heel asks for. Google opens in a new tab; keep this one.</p>
    <p>
      <a class="btn btn-primary" href="${props.google}" target="_blank" rel="noopener noreferrer"
        >Continue to Google</a
      >
    </p>
    <p class="muted">
      Google may say it hasn't verified heel yet. Select <strong>Advanced</strong>, then
      <strong>Go to heel</strong>.
    </p>
  </li>`;
}

/**
 * Signing a Gmail or Calendar account in with heel's built-in Google client
 * (roadmap 1.14). Google sends the browser back to a loopback address on
 * heel's host. On that machine the sign-in finishes by itself; anywhere
 * else the address can't load, and the person copies it back here.
 */
export function loopbackSignInPage(props: LoopbackSignInProps): Html {
  const steps = props.remote
    ? html`${googleStep(props)}
        <li>
          <p>
            Google ends on a page that won't load. That's expected: heel runs on another machine.
            On that page, tap the address bar and copy the whole address (it starts
            <code>http://127.0.0.1</code>).
          </p>
          <p class="muted">
            If heel runs on this device, the Google tab shows Connections instead, and you're done.
          </p>
        </li>
        <li>
          <p>Come back to this tab and choose <strong>Paste and finish</strong>.</p>
          ${pasteForm(props)}
        </li>`
    : html`${googleStep(props)}
        <li>
          <p>
            <strong>On the computer heel runs on,</strong> that's it: the account connects, and the
            tab shows Connections.
          </p>
          <p>
            <strong>On another device,</strong> or with heel in Docker, Google's last page won't load
            (an address starting <code>http://127.0.0.1</code>). Copy that address from the address
            bar, come back to this tab and choose <strong>Paste and finish</strong>.
          </p>
          ${pasteForm(props)}
        </li>`;
  return html`<h1>Sign in ${props.alias} with Google</h1>
    <ol class="steps">
      ${steps}
    </ol>
    <p class="muted">This sign-in expires in 10 minutes. <a href="/connections">Back to Connections</a></p>
    <script>${trusted(PASTE_SCRIPT)}</script>`;
}
