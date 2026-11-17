> **Exported from the Obvious project `prj_rqc5uhH3`.** Source: *heel research — provider API verification* (document `art_zWpwHNdc`), last updated 2026-11-13T22:10:18.184Z. Export date: 2026-11-17.

# heel research — provider API verification

Research only. No code, branches or PRs were created. Retrieval date for every source: 2026-11-13.

## What this settles

**Outlook drafts exist, so the D9 risk is closed.** Graph v1.0 has `createReply`, `createReplyAll` and `createForward`. Each returns `201` with a draft Message whose recipients Graph has already filled in. The spec's fallback (Gmail-style derivation) is not needed. The spec's Outlook path (create the draft, read its recipients, check them, send the checked MIME through `sendMail`, delete the draft) maps onto documented endpoints.

**Every action in the spec's catalogue for the five unresearched providers has an endpoint, except three persistence categories that have no API.** Notion has no sharing or public-link endpoint, Stripe restricted API keys are created only in the Dashboard, and Slack incoming webhooks are minted only during an OAuth install that asks for the `incoming-webhook` scope. (Linear API keys are a fourth case: no mutation exists.) None of these needs a deny rule on the call path; they need a check at connect time instead (see each provider's differences list).

**Five findings change what D12 must build:**

1. **Graph `event: forward` sends meeting invitations with only `Calendars.Read`** as its least-privileged permission. A read-only grant can therefore email new people. heel must map it to `calendar.event.update` with `ToRecipients` as recipients, never to `calendar.read`.
2. **Graph sends invitations on event create and there is no switch to stop it.** There is no `sendUpdates` equivalent. Google has one (`sendUpdates`), but its doc says "some emails might still be sent" even with `none`. In both providers, attendees must be treated as recipients on every write.
3. **Google `events.quickAdd` creates an event from free text**, so attendees are not in the arguments. heel cannot resolve recipients before the call and should deny it.
4. **Push channels on both calendars need only read permission.** Google `events.watch` accepts `calendar.readonly`; Graph subscriptions on events need `Calendars.Read`. A read-only agent can create a channel that outlives revocation, which is exactly the I-70 case.
5. **Stripe `refund.amount` is optional** (absent means the full remaining amount) and **`payment_intents.create` charges only when `confirm=true`**. Rules on `amount` therefore need a read of the charge or PaymentIntent first, and `stripe.payment.create` must cover the separate confirm call too.

API versions pinned by this document: Microsoft Graph **v1.0**, Google Calendar API **v3**, Slack Web API (unversioned), Linear GraphQL (versionless; schema read at `linear/linear` commit `4a8d94a542298412c543945e7da29e4cbc2a3326`), Notion **`Notion-Version: 2026-03-11`**, Stripe **`2026-10-28.endive`**.

## How to read the sources

Every URL in the tables was fetched this session, either through the web fetch tool or with `curl` in the sandbox (for Notion's `.md` page variants, Notion's `llms.txt` index, Stripe's permissions reference and Linear's schema). All Microsoft, Google and Slack URLs were re-requested at the end of the session and returned HTTP 200. **Inference** marks a conclusion drawn from documented facts. **Unconfirmed** marks something no fetched page settled.

The spec's catalogue (from `art_pghXabd9`, "Built-in providers") is the source of the "spec action" column. Outlook mail actions come from the spec's email table; this document covers only the reply-draft path the task named.

---

## 1. Outlook mail (D9): reply, reply-all and forward drafts

| Spec action | Method and endpoint | API version | Required scope | Item field | Recipient field | Official doc URL | Notes |
|---|---|---|---|---|---|---|---|
| `email.send` (reply): create draft | `POST /me/messages/{id}/createReply` | v1.0 | `Mail.ReadWrite` | 1 | Filled by Graph from original `replyTo`, else `from`; read back from the returned draft | https://learn.microsoft.com/en-us/graph/api/message-createreply?view=graph-rest-1.0 | Returns `201` + Message. JSON or MIME (base64 `text/plain`). `comment` and `message.body` together → `400`. Doc: "Send the draft message in a subsequent operation." |
| `email.send` (reply-all): create draft | `POST /me/messages/{id}/createReplyAll` | v1.0 | `Mail.ReadWrite` | 1 | Filled by Graph: `replyTo` + `toRecipients` semantics per doc; read back from the draft | https://learn.microsoft.com/en-us/graph/api/message-createreplyall?view=graph-rest-1.0 | `201` + Message. Whether the account's own address and original Bcc are dropped is still **unconfirmed**; reading the draft's recipients makes this moot. |
| `email.send` (forward): create draft | `POST /me/messages/{id}/createForward` | v1.0 | `Mail.ReadWrite` | 1 | `toRecipients` param **or** `message.toRecipients` (both or neither → `400`); MIME uses To/CC/BCC headers | https://learn.microsoft.com/en-us/graph/api/message-createforward?view=graph-rest-1.0 | `201` + Message. |
| Read draft as MIME | `GET /me/messages/{id}/$value` | v1.0 | `Mail.Read` (**unconfirmed**: concept page does not give the permission table) | — | Parsed from MIME headers | https://learn.microsoft.com/en-us/graph/outlook-get-mime-message | Gives heel the exact bytes to check and send. |
| `email.send`: send checked bytes | `POST /me/sendMail` (MIME, base64 `text/plain`) | v1.0 | `Mail.Send` | 1 | To/Cc/Bcc headers of the MIME | https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0 | `202` means accepted, not delivered. Malformed MIME → `400`. |
| Delete the draft | `DELETE /me/messages/{id}` | v1.0 | `Mail.ReadWrite` | — | — | https://learn.microsoft.com/en-us/graph/api/message-delete?view=graph-rest-1.0 | `204`. Draft cleanup only; not `email.remove`. |
| Alternative: send draft as-is | `POST /me/messages/{id}/send` | v1.0 | `Mail.Send` | 1 | Draft's stored recipients | https://learn.microsoft.com/en-us/graph/api/message-send?view=graph-rest-1.0 | No body, `Content-Length: 0`, `202`. Works for reply, reply-all and forward drafts. Not race-free: the draft could change between heel's check and the send. |

**Differences from the spec**

- **The spec's assumption holds.** All three draft endpoints exist in v1.0. The fallback in the spec ("Outlook uses the Gmail-style derivation") does not apply. The D9 risk row can be closed.
- **Threading after `sendMail`.** Sending the draft's MIME through `sendMail` keeps whatever `In-Reply-To`/`References` headers the draft MIME carries. Inference: Graph places the sent copy in the conversation from those headers; no fetched page states it. D9 should confirm with a recorded fixture that the sent message gets the original `conversationId`.
- **Scopes.** The Outlook account needs `Mail.ReadWrite` (drafts, delete) and `Mail.Send` (send). The spec does not list scopes; D9's connect flow should request both.

---

## 2. Google Calendar API v3

Base: `https://www.googleapis.com/calendar/v3`. Write scopes on events: `calendar`, `calendar.events`, `calendar.app.created`, `calendar.events.owned`.

| Spec action | Method and endpoint | API version | Required scope | Item field | Recipient field | Official doc URL | Notes |
|---|---|---|---|---|---|---|---|
| `calendar.read` | `GET /calendars/{calendarId}/events` | v3 | any of `calendar.readonly`, `calendar.events.readonly`, `calendar`, `calendar.events`, owned/public read-only variants | `items[]` (max 2,500 per page, default 250) | — | https://developers.google.com/workspace/calendar/api/v3/reference/events/list | `q` searches attendee email among other fields. |
| `calendar.read` | `GET /calendars/{calendarId}/events/{eventId}` | v3 | read scopes as above | 1 | — | https://developers.google.com/workspace/calendar/api/v3/reference/events/get | Also the pre-read for update and delete recipients. |
| `calendar.event.create` | `POST /calendars/{calendarId}/events?sendUpdates=` | v3 | write scopes | 1 | `attendees[].email` | https://developers.google.com/workspace/calendar/api/v3/reference/events/insert | `sendUpdates`: `all`, `externalOnly`, `none`. Doc warns "some emails might still be sent" with `none`. `sendNotifications` is deprecated. Service accounts need domain-wide delegation to set attendees. |
| `calendar.event.create` | `POST /calendars/{calendarId}/events/quickAdd?text=` | v3 | write scopes | 1 | **Not in arguments** (parsed from free text) | https://developers.google.com/workspace/calendar/api/v3/reference/events/quickAdd | Takes `sendUpdates`. heel cannot resolve recipients first → deny. |
| `calendar.event.create` | `POST /calendars/{calendarId}/events/import` | v3 | write scopes | 1 | `attendees[].email` | https://developers.google.com/workspace/calendar/api/v3/reference/events/import | Private copy of an existing event; no `sendUpdates` parameter. Whether import emails attendees is **unconfirmed**. |
| `calendar.event.update` | `PUT /calendars/{calendarId}/events/{eventId}?sendUpdates=` | v3 | write scopes | 1 | New `attendees[].email` ∪ existing attendees (inference: an update notifies people already on the event) | https://developers.google.com/workspace/calendar/api/v3/reference/events/update | Full replace; no patch semantics. |
| `calendar.event.update` | `PATCH /calendars/{calendarId}/events/{eventId}?sendUpdates=` | v3 | write scopes | 1 | As above | https://developers.google.com/workspace/calendar/api/v3/reference/events/patch | Arrays overwrite: a patched `attendees` replaces the whole list. |
| `calendar.event.update` | `POST /calendars/{calendarId}/events/{eventId}/move?destination=` | v3 | `calendar`, `calendar.events`, `calendar.events.owned` | 1 | Existing attendees | https://developers.google.com/workspace/calendar/api/v3/reference/events/move | Changes the organizer to the destination calendar. Takes `sendUpdates`. |
| `calendar.event.delete` | `DELETE /calendars/{calendarId}/events/{eventId}?sendUpdates=` | v3 | write scopes | 1 (recurring series: **unconfirmed**) | Existing attendees (read first) | https://developers.google.com/workspace/calendar/api/v3/reference/events/delete | Empty response body. |
| Persistence: ACL grant | `POST /calendars/{calendarId}/acl` | v3 | `calendar`, `calendar.acls` | 1 | `scope.value` (email or domain) | https://developers.google.com/workspace/calendar/api/v3/reference/acl/insert | `scope.type` `default` means **public**. `sendNotifications` defaults to true. Roles up to `owner`. |
| Persistence: ACL change | `PUT` / `PATCH /calendars/{calendarId}/acl/{ruleId}` | v3 | `calendar`, `calendar.acls` | 1 | `scope.value` | https://developers.google.com/workspace/calendar/api/v3/reference/acl/update · https://developers.google.com/workspace/calendar/api/v3/reference/acl/patch | Patch doc: no notification on removal. |
| Persistence: push channel | `POST /calendars/{calendarId}/events/watch` | v3 | **read scopes accepted** (`calendar.readonly` etc.) | 1 | `address` (webhook URL) | https://developers.google.com/workspace/calendar/api/v3/reference/events/watch | Body `id`, `token`, `type: web_hook`, `address`, `params.ttl` (default 604,800 s = 7 days). |
| Persistence: push channel | `POST /calendars/{calendarId}/acl/watch` | v3 | `calendar`, `calendar.acls`, `calendar.acls.readonly` | 1 | `address` | https://developers.google.com/workspace/calendar/api/v3/reference/acl/watch | Default TTL 604,800 s. |
| Persistence: push channel | `POST /users/me/calendarList/watch` | v3 | `calendar.readonly`, `calendar`, `calendar.calendarlist`, `calendar.calendarlist.readonly` | 1 | `address` | https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/watch | Not in the spec. |
| Persistence: push channel | `POST /users/me/settings/watch` | v3 | `calendar.readonly`, `calendar`, `calendar.settings.readonly` | 1 | `address` | https://developers.google.com/workspace/calendar/api/v3/reference/settings/watch | Not in the spec. |
| Cleanup (not persistence) | `POST /channels/stop` | v3 | — | 1 | — | https://developers.google.com/workspace/calendar/api/v3/reference/channels/stop | `{id, resourceId}`. Safe to allow; it only removes a channel. |

**Differences from the spec**

- **Recipients on update and delete are the event's existing attendees, not just the arguments.** The spec says `recipients` = attendees. For update, patch, move and delete, heel must read the event first and union old and new attendees. A failed read denies, per the spec's normalisation rule.
- **heel should set `sendUpdates` itself.** Pass an explicit value on every write so the account default never decides. Because Google warns emails may still go out with `none`, treat attendees as recipients regardless of `sendUpdates`.
- **Deny `events.quickAdd`.** Recipients are unknowable before the call. Mark it unsupported in the definition.
- **Missed persistence endpoints:** `calendarList.watch`, `settings.watch` and `acl.watch` in addition to `events.watch`. All four create channels with a 7-day default TTL, and each accepts a read-only scope.
- **Public ACL.** `acl.insert` with `scope.type: default` makes the calendar public. It should be its own hard-deny case, not just a persistence category.
- **Recurring events.** Whether deleting a series master counts as one item or one per instance was not confirmed. D12 should count it as 1 and flag it, or expand by listing instances.

---

## 3. Microsoft Graph calendar v1.0

| Spec action | Method and endpoint | API version | Required scope | Item field | Recipient field | Official doc URL | Notes |
|---|---|---|---|---|---|---|---|
| `calendar.read` | `GET /me/events`, `/me/calendar/events`, `/me/calendars/{id}/events` | v1.0 | `Calendars.ReadBasic`, `Calendars.Read` or `Calendars.ReadWrite` | `value[]` | — | https://learn.microsoft.com/en-us/graph/api/user-list-events?view=graph-rest-1.0 | Returns single instances and series masters. Bodies are HTML. |
| `calendar.read` | `GET /me/events/{id}` | v1.0 | `Calendars.ReadBasic`, `Calendars.Read` | 1 | — | https://learn.microsoft.com/en-us/graph/api/event-get?view=graph-rest-1.0 | Pre-read for update and delete recipients. |
| `calendar.event.create` | `POST /me/events`, `POST /me/calendars/{id}/events` | v1.0 | `Calendars.ReadWrite` | 1 | `attendees[].emailAddress.address` (`type`: required, optional, resource) | https://learn.microsoft.com/en-us/graph/api/user-post-events?view=graph-rest-1.0 | Doc: the server sends invitations to all attendees and this "can't be configured". `201`. |
| `calendar.event.update` | `PATCH /me/events/{id}` | v1.0 | `Calendars.ReadWrite` | 1 | Changed attendees; all attendees when a distribution-list member is removed | https://learn.microsoft.com/en-us/graph/api/event-update?view=graph-rest-1.0 | Update with only `attendees` notifies changed attendees only. `hideAttendees` available. |
| `calendar.event.update` | `POST /me/events/{id}/forward` | v1.0 | **`Calendars.Read`** (least privileged) | 1 | `ToRecipients` | https://learn.microsoft.com/en-us/graph/api/event-forward?view=graph-rest-1.0 | Sends a meeting request to new recipients and notifies the organizer. `202`. Not available in US Gov L4/L5. |
| `calendar.event.update` (RSVP) | `POST /me/events/{id}/accept` | v1.0 | `Calendars.ReadWrite` | 1 | Organizer (when `sendResponse` is true, the default) | https://learn.microsoft.com/en-us/graph/api/event-accept?view=graph-rest-1.0 | `202`. Decline and tentative were not fetched (**unconfirmed**). |
| `calendar.event.delete` | `DELETE /me/events/{id}` | v1.0 | `Calendars.ReadWrite` | 1 (series master: **unconfirmed**) | Existing attendees, when the caller is the organizer | https://learn.microsoft.com/en-us/graph/api/event-delete?view=graph-rest-1.0 | Organizer delete sends a cancellation. `204`. |
| `calendar.event.delete` | `POST /me/events/{id}/cancel` | v1.0 | `Calendars.ReadWrite` | 1 | Existing attendees | https://learn.microsoft.com/en-us/graph/api/event-cancel?view=graph-rest-1.0 | Organizer only (attendee → `400`). Optional `comment`. Moves the event to Deleted Items. `202`. |
| Persistence: sharing grant | `POST /me/calendar/calendarPermissions` (also `/users/{id}/calendar/…`) | v1.0 | Permission table lists `Calendars.Read` and `Calendars.ReadWrite`; group calendars `Group.ReadWrite.All` | 1 | `emailAddress` | https://learn.microsoft.com/en-us/graph/api/calendar-post-calendarpermissions?view=graph-rest-1.0 | Shares or delegates the calendar. Body `emailAddress`, `isInsideOrganization`, `isRemovable`, `role`. |
| Persistence: sharing change | `PATCH /users/{id}/calendar/calendarPermissions/{id}` | v1.0 | `Calendars.ReadWrite` | 1 | — | https://learn.microsoft.com/en-us/graph/api/calendarpermission-update?view=graph-rest-1.0 | Changes `role`. |
| Persistence: subscription | `POST /subscriptions` (resource `/me/events`) | v1.0 | **`Calendars.Read`** (delegated work, delegated personal and application) | 1 | `notificationUrl` | https://learn.microsoft.com/en-us/graph/api/subscription-post-subscriptions?view=graph-rest-1.0 | Doc: "your app must have read permissions for the resource". The same page shows `Mail.Read` suffices for message subscriptions (the spec's Outlook persistence row). |

**Differences from the spec**

- **No `sendUpdates` equivalent.** Graph always notifies attendees on create, notifies changed attendees on update and sends cancellations on organizer delete. The spec's "recipients = attendees" is correct, but D12 cannot offer a "silent" write on Outlook.
- **`event: forward` is a send under a read permission.** Map it to `calendar.event.update` with `ToRecipients` as recipients. A rule that allows `calendar.read` must never match it.
- **`cancel` is a second delete path**, and `accept` (plus decline and tentative, unconfirmed) send email to the organizer. The spec's catalogue has no RSVP action. Either map RSVPs to `calendar.event.update` or add `calendar.event.respond`.
- **Sharing via calendarPermissions is listed with `Calendars.Read`** in the permission table I read. Inference: any calendar grant may be able to share. D12 must deny it unless a rule names it, regardless of the granted scope.
- **Subscriptions need only read permission**, confirming the spec's persistence category for both mail and calendar.

---

## 4. Slack Web API

Base: `https://slack.com/api/`. The Web API is not versioned.

| Spec action | Method and endpoint | API version | Required scope | Item field | Recipient field | Official doc URL | Notes |
|---|---|---|---|---|---|---|---|
| `slack.read` | `GET conversations.history` | unversioned | `channels:history`, `groups:history`, `im:history`, `mpim:history` | `messages[]` (limit default 100, max 999) | — | https://docs.slack.dev/reference/methods/conversations.history | Cursor pagination. |
| `slack.read` | `GET conversations.replies` | unversioned | `*:history` as above | `messages[]` (limit default 1,000) | — | https://docs.slack.dev/reference/methods/conversations.replies | `channel` + `ts`. |
| `slack.read` (and the state source for `channel`) | `GET conversations.info` | unversioned | `channels:read`, `groups:read`, `im:read`, `mpim:read` | 1 | — | https://docs.slack.dev/reference/methods/conversations.info | Returns `is_shared`, `is_ext_shared`, `is_org_shared`, `is_pending_ext_shared`, `pending_shared`, `shared_team_ids`, `is_im`, `is_mpim`, `is_private`. This is how heel learns "shared externally". |
| `slack.post` | `POST chat.postMessage` | unversioned | `chat:write` | 1 | `channel` (ID or name; public, private or IM) | https://docs.slack.dev/reference/methods/chat.postMessage | `thread_ts`, `reply_broadcast` (also posts the reply to the channel). `metadata` is visible workspace-wide. |
| `slack.post` | `POST chat.postEphemeral` | unversioned | `chat:write` | 1 | `channel` + `user` | https://docs.slack.dev/reference/methods/chat.postEphemeral | Not persisted. |
| `slack.post` | `POST files.completeUploadExternal` | unversioned | `files:write` | Number of entries in `channels` | `channel_id` or `channels` (comma-separated channel or user ids) | https://docs.slack.dev/reference/methods/files.completeUploadExternal | Posts a file plus `initial_comment` to channels. A posting path the spec did not list. |
| `slack.update` | `POST chat.update` | unversioned | `chat:write` | 1 | `channel` | https://docs.slack.dev/reference/methods/chat.update | `channel` + `ts`. Ephemeral messages can't be updated. `reply_broadcast` allowed. |
| `slack.delete` | `POST chat.delete` | unversioned | `chat:write` | 1 | `channel` | https://docs.slack.dev/reference/methods/chat.delete | A bot token deletes only its own messages; a user token deletes what the user can. |
| Persistence: scheduled message | `POST chat.scheduleMessage` | unversioned | `chat:write` | 1 | `channel` | https://docs.slack.dev/reference/methods/chat.scheduleMessage | `post_at` up to 120 days ahead. ≤30 messages per 5 min per channel. Returns `scheduled_message_id`. |
| Persistence: incoming webhook | **No Web API method.** Created during OAuth install when the scope list includes `incoming-webhook`; the token response carries `incoming_webhook.url` | unversioned | `incoming-webhook` (OAuth scope) | — | `incoming_webhook.channel_id` | https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks | URL is specific to one user and one channel and is a secret. |
| Persistence: app install | `POST apps.manifest.create` | unversioned | App configuration token, `app_configurations:write` | 1 | — | https://docs.slack.dev/reference/methods/apps.manifest.create | Returns `client_secret`, `signing_secret`, `oauth_authorize_url`. A bot or user token cannot call it. |
| Persistence (missed by spec): reminder | `POST reminders.add` | unversioned | user token, `reminders:write` | 1 | — | https://docs.slack.dev/reference/methods/reminders.add | Supports recurrence. Doc: reminder methods began retirement in March 2023 and are degraded. |

**Differences from the spec**

- **"Recipient" on Slack is a channel, and names must be resolved to ids.** `chat.postMessage` accepts a channel name, and DMs are IM channels. heel must resolve names to ids, then call `conversations.info` for the shared flags before rules run. A failed lookup denies.
- **"Shared externally" should cover pending shares.** Treat `is_ext_shared`, `is_pending_ext_shared` or a non-empty `pending_shared` as external.
- **Extra posting paths:** `files.completeUploadExternal` (fans out to several channels; items = channel count) and `chat.postEphemeral`. Both should map to `slack.post`. `reply_broadcast: true` on a thread reply also posts to the channel.
- **Incoming webhooks and app installs are unreachable from a stored token.** Webhooks come only from an OAuth install that requests `incoming-webhook`; `apps.manifest.create` needs a configuration token. heel should refuse to request `incoming-webhook` at connect time and never store a configuration token. No call-path deny is needed, but the definition should say so explicitly.
- **`reminders.add` is a persistence path the spec missed.** Deny unless a rule names it.

---

## 5. Linear GraphQL

Endpoint `https://api.linear.app/graphql`. Linear documents no version header; the schema is introspectable and was read from the official `linear/linear` repo at commit `4a8d94a`.

Schema source for every mutation row: https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql (1,584,182 bytes, downloaded with `curl`).

| Spec action | Method and endpoint | API version | Required scope | Item field | Recipient field | Official doc URL | Notes |
|---|---|---|---|---|---|---|---|
| `linear.read` | `query issue(id)`, `query issues(filter…)` | versionless (schema `4a8d94a`) | `read` (always granted) | 1 / `nodes[]` | — | https://linear.app/developers/graphql · schema URL above | `id` takes a UUID or `ENG-123`. Archived issues excluded from `issues` unless `includeArchived`. |
| `linear.issue.create` | `mutation issueCreate(input: IssueCreateInput!)` | versionless | `issues:create` or `write` | 1 | `assigneeId`, `subscriberIds` (people notified; inference) | https://linear.app/developers/oauth-2-0-authentication · schema URL | `teamId` required. Also `projectId`, `labelIds`, `parentId`, `templateId` (may create sub-issues), `createAsUser`, `delegateId`. |
| `linear.issue.create` | `mutation issueBatchCreate` | versionless | `issues:create` or `write` | Number of issues (1–50) | As above, per issue | schema URL | Not in the spec. |
| `linear.issue.update` | `mutation issueUpdate(id, input: IssueUpdateInput!)` | versionless | `issues:create` or `write` | 1 | `assigneeId`, `subscriberIds` | schema URL | Schema: changes "can also trigger team workflow behavior". |
| `linear.issue.update` | `mutation issueBatchUpdate(ids, input)` | versionless | `issues:create` or `write` | `ids.length` (1–50) | As above | schema URL | One transaction. |
| `linear.issue.delete` | `mutation issueDelete(id, permanentlyDelete)` | versionless | `write` (inference: `issues:create` covers only create and update) | 1 + unarchived sub-issues | — | schema URL | Trashes the issue and its unarchived sub-issues with a 30-day grace period. `permanentlyDelete: true` skips the grace period and needs entity-management permission. |
| `linear.issue.delete` (archive) | `mutation issueArchive(id, trash)` | versionless | `write` | 1 + sub-issues | — | schema URL | Archives the issue and its sub-issues. |
| `linear.comment` | `mutation commentCreate(input: CommentCreateInput!)` | versionless | `comments:create` or `write` | 1 | Issue subscribers (inference) | https://linear.app/developers/oauth-2-0-authentication · schema URL | Author is subscribed unless `doNotSubscribeToIssue`. `createOnSyncedSlackThread` posts into a synced Slack thread. |
| Persistence: webhook | `mutation webhookCreate(input: WebhookCreateInput!)` | versionless | `admin`, or a workspace admin | 1 | `url` | https://linear.app/developers/webhooks · schema URL | `teamId` or `allPublicTeams`, `resourceTypes`, `secret`. Returns the signing secret. Also `webhookUpdate`. |
| Persistence: OAuth app | `mutation oauthApplicationCreate` (ALPHA) | versionless | workspace API-management permission | 1 | — | schema URL | Returns `clientSecret` and `webhookSecret`. Also `oauthApplicationRotateSecret`, `…Update`, `…Archive`. |
| Persistence: API key | **No mutation in the public schema** | — | — | — | — | https://linear.app/developers/graphql · schema URL | Personal API keys are created in Security & access settings. No `apiKeyCreate` in the schema. |

**Differences from the spec**

- **Item counts must expand.** `issueBatchUpdate` and `issueBatchCreate` take up to 50; `issueDelete` and `issueArchive` cascade to sub-issues. Expand by reading the issue's children first.
- **There is no recipient field, but writes notify people.** Assignee, subscribers and comments trigger notifications (inference from the schema wording). If D12 wants a people check, use `assigneeId` and `subscriberIds`; otherwise rules match on `team` and `project` as the spec says.
- **Cross-provider egress:** `commentCreate.createOnSyncedSlackThread` posts to Slack. Deny it unless a rule names it, or treat it as `slack.post`.
- **API keys have no API**, so the spec's "API keys" persistence category is unreachable and can be marked so. The real persistence surface is wider than the spec lists: `webhookCreate`/`webhookUpdate`, `oauthApplicationCreate` and its secret rotation, and roughly 40 `integration*` mutations (Slack, GitHub, GitLab, Discord, Zendesk, Salesforce, Microsoft Teams connects, plus `integrationTemplateCreate`). Deny the whole `integration*` family and `oauthApplication*` by default.
- **Scopes.** Request `read`, `issues:create` and `comments:create`. `write` is needed only for delete and archive, and `admin` should never be requested.

---

## 6. Notion API

Base `https://api.notion.com`. **`Notion-Version: 2026-03-11`** is required on every request; the OpenAPI enum for the header contains only `2026-03-11` and states it is the latest. Scopes are "capabilities" set on the connection: Read content, Update content, Insert content, Read comments, Insert comments.

| Spec action | Method and endpoint | API version | Required scope | Item field | Recipient field | Official doc URL | Notes |
|---|---|---|---|---|---|---|---|
| `notion.read` | `GET /v1/pages/{page_id}` | 2026-03-11 | Read content | 1 | — | https://developers.notion.com/reference/retrieve-a-page | Page fields include `public_url`, `in_trash`, `is_archived`, `is_locked`. Property arrays truncated at 25 references. |
| `notion.read` | `POST /v1/data_sources/{data_source_id}/query` | 2026-03-11 | Read content | `results[]` | — | https://developers.notion.com/reference/query-a-data-source | A POST that only reads; must map to `kind: read`. |
| `notion.read` | `POST /v1/search` | 2026-03-11 | Read content | `results[]` | — | https://developers.notion.com/reference/post-search | Title search. A POST that only reads. |
| `notion.read` | Retrieve block children | 2026-03-11 | Read content | `results[]` | — | https://developers.notion.com/llms.txt | Listed in the index; path and method not read (**unconfirmed**). |
| `notion.page.create` | `POST /v1/pages` | 2026-03-11 | Insert content | 1 | People in `people` properties and mentions (inference) | https://developers.notion.com/reference/post-page | `parent`: `page_id` or `data_source_id`; public connections and personal tokens may omit it to create a workspace-level private page. `template` applies asynchronously. `markdown` + `allow_async` returns `202`. |
| `notion.page.update` | `PATCH /v1/pages/{page_id}` | 2026-03-11 | Update content | 1 | People added to `people` properties; mentions | https://developers.notion.com/reference/patch-page | `properties`, `icon`, `cover`, `is_locked`, `template`, `erase_content` (deletes all children; irreversible via API), `notifications.mode: silent`. Parent cannot change here. |
| `notion.page.update` | `PATCH /v1/blocks/{block_id}/children` | 2026-03-11 | Insert content (inference) | Number of blocks appended | Mentions | https://developers.notion.com/reference/patch-block-children | Appends content; a page id works as `block_id`. |
| `notion.page.update` | `PATCH /v1/pages/{page_id}/markdown` | 2026-03-11 | Update content (inference) | 1 | Mentions | https://developers.notion.com/reference/update-page-markdown | Inserts or replaces content as markdown. |
| `notion.page.update` (move) | `POST /v1/pages/{page_id}/move` | 2026-03-11 | edit access to the new parent | 1 | — | https://developers.notion.com/reference/move-page | `parent`: `page_id` or `data_source_id`. Moving changes who can see the page (it inherits the new parent's access; inference). |
| `notion.page.delete` | `PATCH /v1/pages/{page_id}` `{"in_trash": true}` | 2026-03-11 | Update content | 1 (+ child pages: **unconfirmed**) | — | https://developers.notion.com/reference/trash-page | "The API does not support permanently deleting pages." `archived` was removed in 2026-03-11; only `in_trash` is accepted. |
| `notion.page.delete` | `DELETE /v1/blocks/{block_id}` | 2026-03-11 | Update content | 1 | — | https://developers.notion.com/reference/delete-a-block | Sets `in_trash: true` on any block, including page blocks. |
| (no spec action) comment | `POST /v1/comments` | 2026-03-11 | Insert comments | 1 | Mentions in `rich_text` | https://developers.notion.com/reference/create-a-comment | Target `parent.page_id`, `parent.block_id` or `discussion_id`. |
| Persistence: sharing or public link | **No endpoint** | — | — | — | — | https://developers.notion.com/llms.txt | The reference index has no sharing, permission or public-link endpoint. `public_url` is read-only. |
| Persistence: webhook | **No endpoint**; created in the connection's Webhooks tab | — | — | — | — | https://developers.notion.com/reference/webhooks | Subscription is set up in the UI and verified with a `verification_token`. |
| Version check | `Notion-Version` header | 2026-03-11 | — | — | — | https://developers.notion.com/reference/versioning · https://developers.notion.com/page/changelog | Changelog (latest entry Nov 11, 2026): the next version will make markdown v2 the default on pages and comments. |

Capabilities source: https://developers.notion.com/reference/capabilities.

**Differences from the spec**

- **"Database id" is now "data source id".** Under 2026-03-11, page parents and moves use `data_source_id`, not `database_id`. The spec's rule field "parent page or database id" should become "parent page or data source id".
- **Delete is two paths, and both are reversible trash.** `PATCH in_trash` and `DELETE /v1/blocks/{id}`. There is no permanent delete. But `PATCH … erase_content: true` irreversibly deletes a page's content, so it should map to `notion.page.delete`, not `notion.page.update`.
- **`notion.page.update` covers four endpoints**: page properties, append block children, markdown update and move. Update a block (`PATCH /v1/blocks/{id}`) is in the index but its page was not read (**unconfirmed**).
- **Two reads are POSTs** (data source query, search). The definition must mark them `kind: read` explicitly.
- **Comments have no spec action.** Add `notion.comment`, or fold it into `notion.page.update`.
- **Writes can start agents.** The Nov 9, 2026 changelog says assigning a Custom Agent in a `people` property can start an agent run. Deny people-property writes that name a bot user unless a rule allows it.
- **Persistence:** sharing, public links and webhooks have no API, so there is nothing to deny on the call path. The spec's persistence row should say "none reachable via API" rather than stay silent (P-5).

---

## 7. Stripe API

Base `https://api.stripe.com`. Current version **`2026-10-28.endive`**; requests use the account default unless `Stripe-Version` is set, so heel should always send the header. Scopes are restricted-API-key (RAK) permissions.

| Spec action | Method and endpoint | API version | Required scope | Item field | Recipient field | Official doc URL | Notes |
|---|---|---|---|---|---|---|---|
| `stripe.read` | `GET /v1/payment_intents` | 2026-10-28.endive | `payment_intent_read` | `data[]` | — | https://docs.stripe.com/api/payment_intents/list · https://docs.stripe.com/keys/permissions-reference | Filter `customer`. |
| `stripe.read` | `GET /v1/refunds` | 2026-10-28.endive | `charge_read` | `data[]` | — | https://docs.stripe.com/api/refunds/list · permissions reference | Filter `charge`, `payment_intent`. |
| `stripe.read` | `GET /v1/customers/{id}` | 2026-10-28.endive | `customer_read` | 1 | — | https://docs.stripe.com/api/customers/update · permissions reference | Retrieve shown on the same page. |
| `stripe.read` | `GET /v1/charges` | 2026-10-28.endive | `charge_read` | `data[]` | — | https://docs.stripe.com/keys/permissions-reference | Only the permission row was read; the charges page was not fetched. |
| `stripe.refund` | `POST /v1/refunds` | 2026-10-28.endive | **unconfirmed** (not listed in the permissions table; `POST /v1/refunds/{id}` is `charge_write`) | 1 | `email` (refund instructions for some methods) | https://docs.stripe.com/api/refunds/create | `charge` or `payment_intent`; `amount` optional (absent = full remaining); `currency`, `customer`, `reason`. `reason: fraudulent` adds the card and email to block lists. |
| `stripe.payment.create` | `POST /v1/payment_intents` | 2026-10-28.endive | **unconfirmed** (not listed; `capture` is `payment_intent_write`) | 1 | `receipt_email` | https://docs.stripe.com/api/payment_intents/create | Charges only when `confirm=true`. `off_session` only with confirm. In live mode a receipt goes to `receipt_email`. |
| `stripe.payment.create` | `POST /v1/payment_intents/{id}/capture` | 2026-10-28.endive | `payment_intent_write` | 1 | — | permissions reference | Moves money on an authorised intent. Confirm (`/confirm`) was not fetched (**unconfirmed**). |
| `stripe.customer.update` | `POST /v1/customers/{id}` | 2026-10-28.endive | **unconfirmed** (not listed; `DELETE /v1/customers/{id}` is `customer_write`) | 1 | `email` (where invoices go; inference from "shipping appears on invoices emailed to this customer") | https://docs.stripe.com/api/customers/update | Passing `source` sets the active card and retries the latest open invoice of past-due subscriptions, which can charge. |
| `stripe.subscription.update` | `POST /v1/subscriptions/{id}` | 2026-10-28.endive | `subscription_write` | 1 (up to 20 `items`) | — | https://docs.stripe.com/api/subscriptions/update | Prorates by default. `proration_behavior: always_invoice` invoices and attempts payment at once; an interval change, free-to-paid or trial change charges immediately. |
| Persistence: webhook endpoint | `POST /v1/webhook_endpoints` (update `POST /v1/webhook_endpoints/{id}`) | 2026-10-28.endive | `webhook_write` | 1 | `url` | https://docs.stripe.com/api/webhook_endpoints/create · permissions reference | `enabled_events: ['*']`; `connect: true` receives events from all connected accounts. Returns `secret`. |
| Persistence: restricted API key | **No public endpoint**; created in the Dashboard with two-factor verification | — | — | — | — | https://docs.stripe.com/keys/restricted-api-keys | Search snippet only: a private-preview "managed API keys" feature lets approved Stripe Apps create keys (**unconfirmed**; page not fetched). |
| Persistence (missed): app secrets | `POST /v1/apps/secrets` | 2026-10-28.endive | `secret_write` | 1 | — | permissions reference | Stores secrets for Stripe Apps. |
| Persistence (missed): payment link | `POST /v1/payment_links` | 2026-10-28.endive | `payment_links_write` | 1 | — | permissions reference | A public URL that takes payments until deactivated. |
| Persistence (missed): portal config | `POST /v1/billing_portal/configurations` | 2026-10-28.endive | `customer_portal_write` | 1 | — | permissions reference | Changes what customers can do in the portal. |

Auth and version sources: https://docs.stripe.com/api/authentication · https://docs.stripe.com/api/versioning.

**Differences from the spec**

- **`amount` is not always in the arguments.** A refund without `amount` refunds the full remaining balance, and a subscription update's charge depends on prices and proration. heel must read the charge or PaymentIntent to fill `amount` and `currency` before rules run, the same pattern as email recipients. For subscription updates, `amount` is unknowable in advance; mark it absent so `amount` conditions don't match.
- **`stripe.payment.create` must cover confirm and capture.** A create without `confirm` moves no money; the later `/confirm` or `/capture` does. Map all three to `stripe.payment.create`.
- **Side-effect charges.** `customers.update` with `source` can retry past-due invoices, and `subscriptions.update` can charge immediately. Rules authors should know `stripe.customer.update` is not money-neutral.
- **Recipients.** `receipt_email` (payment), `email` (refund) and customer `email` decide where Stripe sends mail. The spec lists none; D12 can expose them as `recipients`.
- **Restricted keys have no public API**, so that persistence category is unreachable. The missed categories are app secrets, payment links and billing-portal configuration. Money movement outside the catalogue (`POST /v1/payouts` with `payout_write`, `POST /v1/transfers` with `transfer_write`) should be denied unless a rule names it.
- **Scope gap.** The permissions reference does not list `POST /v1/refunds`, `POST /v1/payment_intents` or `POST /v1/customers/{id}`. Their RAK permissions are **unconfirmed**; D12 should test them against a sandbox key.

---

## Unconfirmed items, in one place

1. Graph `GET /messages/{id}/$value` permission (concept page has no permission table).
2. Graph: whether reply-all drafts drop the account's own address and original Bcc (moot if heel reads the draft).
3. Graph: decline and tentative endpoints; series-master delete item count.
4. Google: whether `events.import` emails attendees; recurring-series delete item count.
5. Notion: retrieve block children and update block paths; whether trashing a page trashes child pages.
6. Stripe: RAK permissions for `POST /v1/refunds`, `POST /v1/payment_intents`, `POST /v1/customers/{id}`; the PaymentIntent `/confirm` page; the managed-API-keys preview.
7. Linear: exact scope for `issueDelete` and `issueArchive` (inferred `write`).
