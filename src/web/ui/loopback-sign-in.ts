import { type Html, html } from "./html.ts";
import type { FormTarget } from "./layout.ts";

export interface LoopbackSignInProps {
  alias: string;
  /** Google's sign-in page for this sign-in. */
  google: string;
  /** Where a pasted address goes. */
  paste: FormTarget;
  state: string;
}

/**
 * Signing a Gmail or Calendar account in with heel's built-in Google client
 * (roadmap 1.14). Google sends the browser back to a loopback address on
 * heel's host. On that machine the sign-in finishes by itself; anywhere
 * else the address can't load, and the person pastes it here.
 */
export function loopbackSignInPage(props: LoopbackSignInProps): Html {
  return html`<h1>Sign in ${props.alias} with Google</h1>
    <ol class="steps">
      <li>
        <p>Sign in with the Google account for <strong>${props.alias}</strong>, and allow what heel asks for.</p>
        <p>
          <a class="btn btn-primary" href="${props.google}" target="_blank" rel="noopener noreferrer"
            >Continue to Google</a
          >
        </p>
        <p class="muted">
          Google may say it hasn't verified heel yet. Select <strong>Advanced</strong>, then
          <strong>Go to heel</strong>.
        </p>
      </li>
      <li>
        <p>
          <strong>On the computer heel runs on,</strong> that's it: the account connects, and the
          tab shows Connections.
        </p>
        <p>
          <strong>On another device,</strong> or with heel in Docker, Google's last page won't load
          (an address starting <code>http://127.0.0.1</code>). Copy that address from the address
          bar and paste it here:
        </p>
        <form method="post" action="${props.paste.action}" class="paste-form">
          <input type="hidden" name="csrf" value="${props.paste.csrfToken}" />
          <input type="hidden" name="state" value="${props.state}" />
          <label for="address">Address of the page that didn't load</label>
          <input
            id="address"
            name="address"
            type="url"
            required
            autocomplete="off"
            spellcheck="false"
            placeholder="http://127.0.0.1:…/?state=…&code=…"
          />
          <button type="submit" class="btn btn-secondary">Finish signing in</button>
        </form>
      </li>
    </ol>
    <p class="muted">This sign-in expires in 10 minutes. <a href="/connections">Back to Connections</a></p>`;
}
