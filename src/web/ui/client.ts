/**
 * The page script that runs passkey ceremonies. `CEREMONY_SCRIPT` (in
 * ceremony.ts) turns a click on a ceremony button into a call to one of the
 * handlers registered here. Every handler follows the same three steps:
 *
 * 1. ask the server for a challenge that names exactly what is being done;
 * 2. let the person's authenticator sign it (`navigator.credentials`);
 * 3. post the signed answer back, then follow the server to the next page.
 *
 * Nothing is decided in the browser. The server reads the decision out of
 * the challenge it issued, never out of what this script sends.
 */

import { MENU_RESET_SCRIPT } from "./approval-request.ts";

/** Safe inside a `<script>`: JSON with `<` escaped, so no value can close the tag. */
function scriptLiteral(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/**
 * The script for one page. `csrfToken` is the signed-in person's token, or
 * null on sign-in and enrollment pages, which have no session yet.
 */
export function clientScript(csrfToken: string | null): string {
  return `
(() => {
  const CSRF = ${scriptLiteral(csrfToken)};

  // ── base64url <-> bytes, for the WebAuthn JSON forms ──
  const toBytes = (b64url) => {
    const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(b64url.length / 4) * 4, "=");
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  };
  const toB64url = (buffer) => {
    let text = "";
    for (const byte of new Uint8Array(buffer)) text += String.fromCharCode(byte);
    return btoa(text).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  };

  const requestOptions = (o) => ({
    ...o,
    challenge: toBytes(o.challenge),
    allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: toBytes(c.id) })),
  });
  const creationOptions = (o) => ({
    ...o,
    challenge: toBytes(o.challenge),
    user: { ...o.user, id: toBytes(o.user.id) },
    excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: toBytes(c.id) })),
  });
  const assertionJson = (cred) => ({
    id: cred.id,
    rawId: toB64url(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: toB64url(cred.response.clientDataJSON),
      authenticatorData: toB64url(cred.response.authenticatorData),
      signature: toB64url(cred.response.signature),
      ...(cred.response.userHandle ? { userHandle: toB64url(cred.response.userHandle) } : {}),
    },
    clientExtensionResults: cred.getClientExtensionResults(),
  });
  const registrationJson = (cred) => ({
    id: cred.id,
    rawId: toB64url(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: toB64url(cred.response.clientDataJSON),
      attestationObject: toB64url(cred.response.attestationObject),
      transports: cred.response.getTransports ? cred.response.getTransports() : [],
    },
    clientExtensionResults: cred.getClientExtensionResults(),
  });

  const post = async (url, body) => {
    const headers = { "content-type": "application/json" };
    if (CSRF) headers["x-heel-csrf"] = CSRF;
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    const json = await response.json().catch(() => ({}));
    if (!response.ok || json.ok === false) throw new Error(json.message || "heel refused the request.");
    return json;
  };

  // The three steps every ceremony shares.
  const run = async ({ status, start, sign, finish, extra }) => {
    const say = (text) => { if (status) status.textContent = text; };
    try {
      say("Getting a passkey challenge…");
      const issued = await post(start.url, start.body);
      say("Waiting for your passkey…");
      const signed = await sign(issued.options);
      say("Checking…");
      const result = await post(finish, { challengeId: issued.challengeId, response: signed, ...(extra || {}) });
      say(result.message || "Done.");
      if (result.next) window.location.assign(result.next);
    } catch (error) {
      const cancelled = error && (error.name === "NotAllowedError" || error.name === "AbortError");
      say(cancelled ? "The passkey check was cancelled. Nothing changed." : String(error.message || error) + " Nothing changed.");
    }
  };
  const getAssertion = async (options) =>
    assertionJson(await navigator.credentials.get({ publicKey: requestOptions(options) }));
  const createCredential = async (options) =>
    registrationJson(await navigator.credentials.create({ publicKey: creationOptions(options) }));

  const DECISIONS = {
    "approve-once": () => ({ intent: "approve" }),
    "approve-standing": (options) => ({ intent: "approve", standing: { scope: options.scope, duration: options.duration } }),
    deny: () => ({ intent: "deny" }),
  };

  // ── notifications on this device (not a ceremony: it can't decide anything) ──
  const pushButton = document.getElementById("heel-push");
  if (pushButton) {
    const pushStatus = document.getElementById("heel-push-status");
    const sayPush = (text) => { if (pushStatus) pushStatus.textContent = text; };
    const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    if (!supported) {
      pushButton.disabled = true;
      sayPush("This browser can't receive notifications. On an iPhone, add heel to your Home Screen and open it from there.");
    }
    // One switch: on when this browser has a subscription, off when it has none.
    const label = (on) => {
      pushButton.setAttribute("aria-checked", on ? "true" : "false");
      pushButton.setAttribute("aria-label", on ? "Turn off notifications on this device" : "Turn on notifications");
      const track = pushButton.querySelector(".ui-switch-track");
      if (track) track.dataset.on = on ? "true" : "false";
      const word = pushButton.querySelector(".ui-switch-word");
      if (word) word.textContent = on ? "On" : "Off";
      pushButton.dataset.on = on ? "1" : "";
    };
    const current = async () => {
      const registration = await navigator.serviceWorker.getRegistration("/");
      return registration ? registration.pushManager.getSubscription() : null;
    };
    if (supported && Notification.permission === "granted") {
      current().then((subscription) => label(Boolean(subscription))).catch(() => {});
    }
    pushButton.addEventListener("click", async () => {
      try {
        if (pushButton.dataset.on) {
          const subscription = await current();
          if (subscription) {
            await post("/push/unsubscribe", { endpoint: subscription.endpoint });
            await subscription.unsubscribe();
          }
          label(false);
          sayPush("Notifications are off for this device.");
          return;
        }
        sayPush("Asking this browser for permission…");
        if ((await Notification.requestPermission()) !== "granted") {
          sayPush("Notifications are blocked for this site. Allow them in the browser's settings.");
          return;
        }
        const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
        await navigator.serviceWorker.ready;
        const subscription =
          (await registration.pushManager.getSubscription()) ||
          (await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: toBytes(pushButton.dataset.key),
          }));
        await post("/push/subscribe", subscription.toJSON());
        label(true);
        sayPush("Notifications are on for this device.");
      } catch (error) {
        sayPush("Couldn't change notifications: " + String((error && error.message) || error));
      }
    });
  }

  // ── remembered folds (not a ceremony: presentation only, it decides nothing) ──
  const foldRoot = document.querySelector("[data-heel-fold-kind]");
  if (foldRoot && CSRF) {
    const kind = foldRoot.getAttribute("data-heel-fold-kind");
    for (const details of foldRoot.querySelectorAll("details[data-heel-fold]")) {
      // Only a change from how the page rendered is remembered, so the
      // browser's own toggle event for an initially open section saves nothing.
      let last = details.open;
      details.addEventListener("toggle", () => {
        if (details.open === last) return;
        last = details.open;
        post("/approvals/folds", { kind, section: details.getAttribute("data-heel-fold"), open: details.open })
          .catch(() => {});
      });
    }
  }

  ${MENU_RESET_SCRIPT}

  window.heelCeremony = {
    signIn: ({ binding, status }) =>
      run({
        status,
        start: { url: "/sign-in/options", body: { challengeId: binding.challengeId } },
        sign: getAssertion,
        finish: "/sign-in",
      }),
    enroll: ({ binding, status }) =>
      run({
        status,
        start: { url: "/enroll/" + encodeURIComponent(binding.token) + "/options", body: {} },
        sign: createCredential,
        finish: "/enroll/" + encodeURIComponent(binding.token),
      }),
    decide: ({ intent, binding, options, status }) =>
      run({
        status,
        start: {
          url: "/approvals/" + encodeURIComponent(binding.approvalId) + "/challenge",
          body: { callHash: binding.callHash, ...DECISIONS[intent](options) },
        },
        sign: getAssertion,
        finish: "/approvals/" + encodeURIComponent(binding.approvalId) + "/decide",
      }),
    connect: ({ binding, status }) =>
      run({
        status,
        start: { url: "/oauth/authorize/challenge", body: binding },
        sign: getAssertion,
        finish: "/oauth/authorize/confirm",
      }),
    addDevice: ({ status }) =>
      run({
        status,
        start: { url: "/devices/challenge", body: {} },
        sign: getAssertion,
        finish: "/devices/confirm",
      }),
    resume: ({ binding, status }) =>
      run({
        status,
        start: { url: "/pause/resume/challenge", body: { scope: binding.scope, target: binding.target } },
        sign: getAssertion,
        finish: "/pause/resume",
      }),
    grant: ({ options, status }) =>
      run({
        status,
        start: {
          url: "/grants/challenge",
          body: { agent: options.agent, task: options.task, match: options.match, duration: options.duration },
        },
        sign: getAssertion,
        finish: "/grants/confirm",
      }),
    saveRules: ({ binding, options, status }) =>
      run({
        status,
        start: { url: "/rules/challenge", body: { before: binding.before, after: binding.after, text: options.text } },
        sign: getAssertion,
        finish: "/rules/confirm",
        extra: { text: options.text },
      }),
    manageAccount: ({ binding, options, status }) => {
      const key = options && typeof options.key === "string" ? options.key : "";
      const body = { ...options, ...binding };
      // The key isn't part of what the passkey signs; it goes only with the signed answer.
      delete body.key;
      return run({
        status,
        start: { url: "/connections/manage/challenge", body },
        sign: getAssertion,
        finish: "/connections/manage/confirm",
        extra: key ? { key } : {},
      }).finally(() => {
        // Whatever happened, the key doesn't stay on the page.
        for (const field of document.querySelectorAll("input[name=key]")) field.value = "";
      });
    },
    managePeople: ({ binding, options, status }) =>
      run({
        status,
        start: { url: "/people/challenge", body: { ...options, ...binding } },
        sign: getAssertion,
        finish: "/people/confirm",
      }),
    manageAgent: ({ binding, options, status }) =>
      run({
        status,
        start: { url: "/agents/manage/challenge", body: { ...options, ...binding } },
        sign: getAssertion,
        finish: "/agents/manage/confirm",
      }),
    applyRules: ({ binding, status }) =>
      run({
        status,
        start: { url: "/proposals/challenge", body: { proposalId: binding.proposalId, sha: binding.sha } },
        sign: getAssertion,
        finish: "/proposals/confirm",
      }),
    approveConnection: ({ binding, options, status }) => {
      const field = document.getElementById("request-key-input");
      // Ask for the key before the passkey, so an empty field doesn't use up a passkey tap.
      if (field && !(options && options.key && options.key.trim())) {
        if (status) status.textContent = "Paste the key first. Nothing changed.";
        field.focus();
        return;
      }
      return run({
        status,
        start: { url: "/requests/challenge", body: { requestId: binding.requestId, hash: binding.hash } },
        sign: getAssertion,
        finish: "/requests/confirm",
        // A pasted key goes only to heel, only with the signed answer.
        extra: options && options.key ? { key: options.key } : {},
      }).finally(() => {
        // Whatever happened, the key doesn't stay on the page.
        if (field) field.value = "";
      });
    },
    mode: ({ binding, status }) =>
      run({
        status,
        start: { url: "/modes/challenge", body: { owner: binding.owner, mode: binding.mode } },
        sign: getAssertion,
        finish: "/modes/confirm",
      }),
  };
})();
`;
}
