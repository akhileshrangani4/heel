import type { PersonView } from "../../store/people.ts";
import { ceremonyButton } from "./ceremony.ts";
import { dialog, dialogTrigger } from "./dialog.ts";
import { type Html, html, trusted } from "./html.ts";
import { ELLIPSIS } from "./icons.ts";
import { badge, notice, scrollRegion, time } from "./layout.ts";
import { btn } from "./shadcn/button.ts";

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

function personRow(
  person: PersonView,
  props: { viewerId: string; admin: boolean },
  index: number,
): Html {
  const key = `p${String(index)}`;
  const you = person.id === props.viewerId;
  return html`<tr class="person" data-person="${person.name}">
    <th scope="row" class="person-name"><strong class="mono">${person.name}</strong>${you ? html` <span class="muted">(you)</span>` : ""}</th>
    <td class="person-role">
      ${badge(person.role === "admin" ? "admin" : "member", person.role === "admin" ? "warn" : "ok")}
      ${person.disabled ? badge("disabled", "error") : ""}
    </td>
    <td class="person-meta muted">${
      person.passkeys === 0
        ? "No passkey yet."
        : `${String(person.passkeys)} passkey${person.passkeys === 1 ? "" : "s"}.`
    } ${person.email === null ? "No notification email." : `Notifications: ${person.email}.`}</td>
    <td class="person-manage">${
      person.disabled
        ? ""
        : html`<details class="set-menu">
          <summary class="${btn("ghost", "icon-sm")}" aria-label="Manage ${person.name}" title="Manage ${person.name}">${trusted(ELLIPSIS)}</summary>
          <div class="set-menu-panel">
            <p class="set-menu-title">Manage ${person.name}</p>
            ${props.admin && !you ? linkButton(person, key) : ""}
            ${emailForm(person, key)}
          </div>
        </details>`
    }</td>
  </tr>`;
}

export function peoplePage(props: {
  people: readonly PersonView[];
  viewerId: string;
  admin: boolean;
  teamSignIn: boolean;
  saved: boolean;
}): Html {
  const canAdd = props.admin && !props.teamSignIn;
  return html`<div class="set-head">
      <div>
        <h1>People</h1>
        <p class="muted">${
          props.admin
            ? "Everyone who uses this heel. Each person has their own agents, accounts and rules, and sees only their own."
            : "You, as heel knows you."
        }</p>
      </div>
      ${canAdd ? dialogTrigger({ dialogId: "add-person-dialog", label: "+ Add person", className: btn("default", "sm") }) : ""}
    </div>
    ${props.saved ? notice("ok", html`<p>Saved.</p>`) : ""}
    ${
      canAdd
        ? dialog({
            id: "add-person-dialog",
            title: "Add a person",
            description:
              "Lower-case, like a username. They get their own rules file and nothing of yours. Next you get a link that sets up their passkey.",
            body: html`<div id="add-person" class="stack-form">
              <input type="hidden" name="op" value="add" />
              <div class="row">
                <label for="add-person-name">Name</label>
                <input id="add-person-name" name="name" maxlength="64" autocomplete="off" placeholder="sam" autocapitalize="off" autocorrect="off" spellcheck="false" />
              </div>
              ${ceremonyButton({
                callback: { handler: "managePeople" },
                intent: "manage-people",
                label: "Add with your passkey",
                tone: "primary",
                binding: {},
                optionsFrom: "add-person",
              })}
            </div>`,
          })
        : props.admin
          ? html`<p class="muted">People join by signing in with your sign-in provider; then they show up here.</p>`
          : ""
    }
    ${scrollRegion(
      "People",
      html`<table class="data person-table">
        <caption class="visually-hidden">People</caption>
        <thead>
          <tr>
            <th scope="col">Person</th>
            <th scope="col">Role</th>
            <th scope="col">Passkeys and notifications</th>
            <th scope="col"><span class="visually-hidden">Manage</span></th>
          </tr>
        </thead>
        <tbody>${props.people.map((p, i) => personRow(p, props, i))}</tbody>
      </table>`,
    )}`;
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
    <p><a class="${btn()}" href="/people">Done</a></p>`;
}
