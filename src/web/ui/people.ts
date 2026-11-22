import type { PersonView } from "../../store/people.ts";
import { ceremonyButton } from "./ceremony.ts";
import { type Html, html } from "./html.ts";
import { badge, notice, time } from "./layout.ts";

/**
 * The People page (roadmap 2.9): who uses this heel, a passkey link for each,
 * and where their notifications go. Admins see everyone; others see
 * themselves.
 */

export interface PeopleLink {
  name: string;
  url: string;
  expiresAt: string;
  /** A recovery link (they already have a passkey) works only from then. */
  activeFrom: string | null;
}

function emailForm(person: PersonView, key: string): Html {
  return html`<div id="email-${key}" class="stack-form">
    <input type="hidden" name="op" value="email" />
    <input type="hidden" name="name" value="${person.name}" />
    <div class="row">
      <label for="email-${key}-address">Notifications go to</label>
      <input id="email-${key}-address" name="email" type="email" maxlength="320" autocomplete="off" value="${person.email ?? ""}" placeholder="name@example.com" />
    </div>
    <p class="muted">Email, and Slack where heel has a Slack token. Empty means none.</p>
    ${ceremonyButton({
      callback: { handler: "managePeople" },
      intent: "manage-people",
      label: "Save with your passkey",
      tone: "secondary",
      binding: {},
      optionsFrom: `email-${key}`,
    })}
  </div>`;
}

function linkButton(person: PersonView, key: string): Html {
  const recovery = person.passkeys > 0;
  return html`<div id="link-${key}" class="form">
    <input type="hidden" name="op" value="link" />
    <input type="hidden" name="name" value="${person.name}" />
    <p class="muted">${
      recovery
        ? "They have a passkey already, so this is a recovery link: it works a day from now, and their Approvals page shows it with a way to cancel."
        : "A one-time link that sets up their passkey. Send it to them only; it works for 15 minutes."
    }</p>
    ${ceremonyButton({
      callback: { handler: "managePeople" },
      intent: "manage-people",
      label: recovery ? "Make a recovery link" : "Make a passkey link",
      tone: "secondary",
      binding: {},
      optionsFrom: `link-${key}`,
    })}
  </div>`;
}

function personCard(
  person: PersonView,
  props: { viewerId: string; admin: boolean },
  index: number,
): Html {
  const key = `p${String(index)}`;
  const you = person.id === props.viewerId;
  return html`<li class="card person">
    <p><strong class="mono">${person.name}</strong>${you ? " (you)" : ""}
      ${badge(person.role === "admin" ? "admin" : "member", person.role === "admin" ? "warn" : "ok")}
      ${person.disabled ? badge("disabled", "error") : ""}</p>
    <p class="muted">${
      person.passkeys === 0
        ? "No passkey yet."
        : `${String(person.passkeys)} passkey${person.passkeys === 1 ? "" : "s"}.`
    } ${person.email === null ? "No notification email." : `Notifications: ${person.email}.`}</p>
    ${
      person.disabled
        ? ""
        : html`<details>
          <summary>Manage ${person.name}</summary>
          ${props.admin && !you ? linkButton(person, key) : ""}
          ${emailForm(person, key)}
        </details>`
    }
  </li>`;
}

export function peoplePage(props: {
  people: readonly PersonView[];
  viewerId: string;
  admin: boolean;
  teamSignIn: boolean;
  saved: boolean;
}): Html {
  return html`<h1>People</h1>
    <p class="muted">${
      props.admin
        ? "Everyone who uses this heel. Each person has their own agents, accounts and rules, and sees only their own."
        : "You, as heel knows you."
    }</p>
    ${props.saved ? notice("ok", html`<p>Saved.</p>`) : ""}
    ${
      props.admin && !props.teamSignIn
        ? html`<section class="card" aria-labelledby="add-person-heading">
          <h2 id="add-person-heading">Add a person</h2>
          <div id="add-person" class="stack-form">
            <input type="hidden" name="op" value="add" />
            <div class="row">
              <label for="add-person-name">Name</label>
              <input id="add-person-name" name="name" maxlength="64" autocomplete="off" placeholder="sam" />
            </div>
            <p class="muted">Lower-case, like a username. They get their own rules file and nothing of yours. Next you get a link that sets up their passkey.</p>
            ${ceremonyButton({
              callback: { handler: "managePeople" },
              intent: "manage-people",
              label: "Add with your passkey",
              tone: "primary",
              binding: {},
              optionsFrom: "add-person",
            })}
          </div>
        </section>`
        : props.admin
          ? html`<p class="muted">People join by signing in with your sign-in provider; then they show up here.</p>`
          : ""
    }
    <ul class="person-list">${props.people.map((p, i) => personCard(p, props, i))}</ul>`;
}

/** The link, once. */
export function personLinkPage(link: PeopleLink | null): Html {
  if (link === null) {
    return html`<h1>Passkey link</h1>
      ${notice(
        "info",
        html`<p>This link was already shown, or more than 10 minutes have passed. heel doesn't keep it.
          Make another from <a href="/people">People</a>.</p>`,
      )}`;
  }
  return html`<h1>${link.name}'s passkey link</h1>
    ${notice(
      "warn",
      html`<p><strong>Copy it now: heel shows it only this once.</strong> Whoever opens it first gets a passkey
        as ${link.name}, so send it to them only.</p>`,
    )}
    <p><label for="person-link">Link</label></p>
    <input id="person-link" class="mono" readonly value="${link.url}" onclick="this.select()" />
    <p class="muted">${
      link.activeFrom === null
        ? html`It works once, until ${time(new Date(link.expiresAt))}.`
        : html`A recovery link: it works from ${time(new Date(link.activeFrom))} until ${time(new Date(link.expiresAt))}. Until then, their Approvals page shows it with a way to cancel.`
    }</p>
    <p><a class="btn btn-primary" href="/people">Done</a></p>`;
}
