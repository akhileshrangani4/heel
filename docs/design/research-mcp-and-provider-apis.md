> **Exported from the Obvious project `prj_rqc5uhH3`.** Source: *heel research — MCP and provider APIs* (document `art_1G3anPKA`), last updated 2026-11-13T19:51:20.820Z. Export date: 2026-11-17.

# heel research — MCP and provider APIs

Read-only research for heel's proxy, built-in definitions, state checks, item counts and `hide`. No code, branches or PRs were created.

**How to read the sources.** Every fact carries a source tag. **[spec]**, **[API]** and **[repo]** mean a primary source was read this session: a cloned repository, a downloaded API description, or a fetched official page. The tag names the file or URL and what it showed. **Inference** marks a conclusion drawn from those facts. **Gap** marks something no reliable source settled. Retrieval date for all sources: 2026-11-13.

**Primary sources consulted**

| Ref | Source | How retrieved |
|---|---|---|
| S1 | `github.com/modelcontextprotocol/modelcontextprotocol`, commit `06e9234` (2026-11-12), `docs/specification/2026-07-28/**` | git clone |
| S2 | Gmail API discovery document, `revision 20261106`, `version v1` | downloaded JSON |
| S3 | developers.google.com/workspace/gmail/api/guides/{sending,threads,batch} | page fetch |
| S4 | developers.google.com/workspace/gmail/api/reference/mcp (+ `tools_list/label_message`, `tools_list/create_draft`) and `guides/configure-mcp-server` | page fetch |
| S5 | learn.microsoft.com Graph v1.0: `user-sendmail`, `message-reply`, `message-replyall`, `message-forward`, `message-send`, `message-delete`, `message-move`, `message-permanentdelete`, `json-batching`, `resources/mailfolder` | page fetch |
| S6 | `microsoftgraph/microsoft-graph-docs-contrib` `api-reference/v1.0/resources/message.md` | raw file download |
| S7 | `github/github-mcp-server`, commit `0663b830582af923e30fb14cb2e10dd3248baa86`, `pkg/github/pullrequests.go` | git clone |
| S8 | GitHub REST OpenAPI description (`info.version` 1.1.4) | downloaded JSON |
| S9 | `taylorwilsdon/google_workspace_mcp` commit `65286d8`, `gmail/gmail_tools.py` | git clone |
| S10 | `GongRzhe/Gmail-MCP-Server` commit `a890d19`, `src/index.ts` | git clone |
| S11 | `ryaker/outlook-mcp` commit `95d6ff2`, `email/*.js`, `folder/index.js`, `rules/*.js` | git clone |
| S12 | cli.github.com/manual: `gh_auth_token`, `gh_auth_status`, `gh_api`, `gh_help_environment`, `gh_alias_set`, `gh_extension`, `gh_pr_merge`, `gh_secret` | page fetch |
| S13 | kubernetes.io: `reference/kubectl/` (overview), `kubectl/kubectl/`, `kubectl_config_view`, `kubectl_create_token`, `kuberc`, `tasks/extend-kubectl/kubectl-plugins` | page fetch |
| S14 | `kubernetes/kubernetes` `staging/src/k8s.io/kubectl/pkg/cmd/cmd.go` (master) and `spf13/cobra` `command.go` (main) | raw file download |
| S15 | WICG "Origin-bound one-time codes delivered via SMS" (Draft CG Report, 2021-03-24) | page fetch |
| S16 | `LeeeSe/MessAuto` `09f9f1f`, `jd1378/otphelper` `a40b8af`, `transitive-bullshit/parse-otp-message` `435cfed` | git clone |

The MCP server choices in §3 come from a GitHub search for Gmail and Outlook MCP servers earlier in this task. I did not re-run that search after the thread compacted. Popularity therefore comes from that search and has not been re-checked here. Tool shapes come from source code (S9–S11).

---

## 0. Facts that most constrain the design

1. **MCP 2026-07-28 is stateless.** It has no `initialize` handshake and no `Mcp-Session-Id`. Every request carries its protocol version and client capabilities in `_meta`. **[spec]** S1 `changelog.mdx` major changes 1–2. Inference: heel's per-run and per-agent identity cannot ride on an MCP session. It must come from heel's own bearer token plus a run id that heel defines.
2. **Token passthrough is forbidden.** "MCP servers MUST NOT accept or transit any other tokens." Clients "MUST NOT send tokens to the MCP server other than ones issued by the MCP server's authorization server." **[spec]** S1 `basic/authorization/index.mdx` (Token Handling). Inference: heel needs two credential planes. The agent sends heel a heel-issued token. heel sends upstream servers the stored provider credentials. heel never forwards one to the other.
3. **Tool annotations are untrusted.** "clients MUST consider tool annotations to be untrusted unless they come from trusted servers." **[spec]** S1 `server/tools.mdx`. Inference: heel cannot classify tools by `destructiveHint` or `readOnlyHint`. Google's own `label_message` is marked "Destructive Hint: ❌", yet adding `TRASH` through the sibling tool removes mail (S4). Action mapping must be built into heel per server and tool.
4. **Recipients often aren't in the arguments.** Gmail `drafts.send` and Graph `message: send` send a stored draft and take no request body (S2, S5). Graph `replyAll` "loads the sender and all recipients of the original message" (S5). taylorwilsdon `send_gmail_message` with `reply_all=True` derives `to` from the thread (S9). Inference: `recipients` must be resolved, sometimes by a provider read, before rules run. If the lookup fails, the call must be denied.
5. **Item counts depend on the shape of the call.** Gmail `batchModify` allows up to 1000 ids (S2). A thread-level `trash` or `delete` affects every message in the thread (S2). Gmail HTTP batch allows up to 100 calls in one `multipart/mixed` request (S3). Graph `$batch` allows up to 20 (S5). GitHub `merge-async` on a stacked PR "includes all open downstack pull requests" (S8). Inference: counting calls is wrong in all of these cases. heel must expand each one.
6. **The race-free merge guard exists in every layer.** REST `sha`: "SHA that pull request head must match", with `409` on mismatch. MCP `expectedHeadSha`. `gh pr merge --match-head-commit`. (S8, S7, S12.)
7. **A CLI's verb depends on its configuration and environment, not only on argv.** gh shell aliases run through `sh` (S12). kubectl `kuberc` aliases rewrite commands and inject arguments (S13). kubectl plugins and gh extensions run arbitrary binaries (S13, S12). Inference: heel's CLI parser must neutralise aliases, kuberc, plugins and extensions, or deny when they are present.
8. **Login-code detection has no reliable primary standard.** The WICG one-time-code spec says heuristic extraction is "often unreliable and error-prone" (S15). Inference: `looks_like` must fail closed. On classifier error, timeout or low confidence, hide the item.

---

## 1. MCP specification (current version: 2026-07-28)

**Current version.** S1 `basic/versioning.mdx` lists `"supported": ["2026-07-28", "2025-11-25"]` in its example and describes per-request version negotiation. `changelog.mdx` lists the changes since 2025-11-25.

### 1.1 `tools/list` and `tools/call`
- **Pagination.** Cursors are opaque: "Pagination in MCP uses an opaque cursor-based approach". A response carries `nextCursor` when more results exist, and the client sends `cursor` to continue. **[spec]** S1 `server/utilities/pagination.mdx` l.26–64; `server/tools.mdx` l.128 shows `nextCursor` on `tools/list`.
- **Caching fields.** `tools/list` results must carry `ttlMs` and `cacheScope` (`"public"` or `"private"`) through `CacheableResult`. Servers SHOULD return tools in a deterministic order. **[spec]** S1 changelog minor changes 3 and 5.
- **Tool definitions.** A tool has `name`, `inputSchema`, an optional `outputSchema` and optional `annotations`. The schema defaults to JSON Schema 2020-12. Any 2020-12 keywords are now allowed, with `$ref` resolution rules. **[spec]** S1 `server/tools.mdx` l.299–306; changelog minor change 10.
- **Results.** Every result has a required `resultType`: `"complete"`, or `"input_required"` for MRTR. Results from older servers that omit it are treated as `"complete"`. **[spec]** S1 changelog major change 8.
- Inference for heel: when heel aggregates several upstream servers into one, it must page through every upstream `tools/list` itself. It then serves its own cursor and must not pass upstream cursors through, because they are opaque and specific to each server.

### 1.2 `isError` vs protocol errors
- **Protocol errors** are JSON-RPC `error` objects, for example `-32602 "Unknown tool"`. They cover unknown tools, malformed requests and server errors. **Tool execution errors** are results with `isError: true`, covering API failures, validation errors and business-logic errors. "Clients SHOULD provide tool execution errors to language models to enable self-correction." Clients only MAY pass protocol errors to the model. **[spec]** S1 `server/tools.mdx` l.740–785.
- **Error code ranges.** `-32000…-32019` is implementation-defined. `-32020…-32099` is reserved for MCP: `HeaderMismatch -32020`, `MissingRequiredClientCapability -32021`, `UnsupportedProtocolVersion -32022`. **[spec]** S1 changelog minor change 12.
- Inference: heel's "denied", "pending approval" and "paused" answers are business-logic outcomes. They should be `isError: true` tool results so the agent's model sees them. As JSON-RPC errors, clients might hide them from the model.

### 1.3 Structured content and output schemas
- `structuredContent` can be any JSON value that conforms to `outputSchema` if one is given. For backwards compatibility, a tool returning structured content SHOULD also return the serialized JSON in a TextContent block. If an `outputSchema` is provided, servers **MUST** return conforming structured results. **[spec]** S1 `server/tools.mdx` l.498–515.
- Inference for `hide`: heel must redact both `structuredContent` and the mirrored text block. A redacted result must still validate against the tool's `outputSchema`, or heel must drop `outputSchema` from the definitions it re-serves. Redacting in only one place leaks.

### 1.4 List-changed notifications
- A server that declares `listChanged` emits `notifications/tools/list_changed`. In 2026-07-28 these arrive only on a `subscriptions/listen` stream where the client opted in with `toolsListChanged: true`. The HTTP GET stream and `resources/subscribe` are removed. **[spec]** S1 `server/tools.mdx` l.238–274; changelog major change 4.
- Inference: an upstream tool list can change during a run. heel must map tools to actions on every `tools/call` against the current definition. Mapping once at connect time is not enough, and an unmapped new tool must be default-denied.

### 1.5 Transports and sessions
- **stdio.** Messages are newline-delimited and "MUST NOT contain embedded newlines". The server MUST NOT write anything but MCP messages to stdout. stderr is for logs and is not an error signal. **[spec]** S1 `basic/transports/stdio.mdx` l.13–20.
- **Streamable HTTP.**
  - Servers MUST validate `Origin`.
  - POST requests accept `application/json` or `text/event-stream` responses.
  - The `MCP-Protocol-Version` header MUST match the `_meta` protocol version, or the server returns `400` with `HeaderMismatch`.
  - New required headers are `Mcp-Method` (all requests) and `Mcp-Name` (`params.name` or `params.uri` for `tools/call`, `resources/read` and `prompts/get`). Non-ASCII values use `=?base64?…?=` encoding.
  - Parameters annotated with `x-mcp-header` are mirrored as `Mcp-Param-{name}` headers.

  **[spec]** S1 `basic/transports/streamable-http.mdx` l.58–60, 77–90, 253–306, 359–403, 490–502.
- **Sessions removed.** Protocol-level sessions and `Mcp-Session-Id` are gone. Servers that need cross-call state use "explicit, server-minted handles passed as ordinary tool arguments". SSE resumability (`Last-Event-ID`) is also removed. A broken stream loses the request, and the client must re-issue it with a new id. **[spec]** S1 changelog major changes 1 and 9.
- Inference: heel sits in the middle, so it must rewrite `Mcp-Name` and `Mcp-Param-*` headers consistently with any argument rewriting. One example is injecting `sha` into a merge. Otherwise upstream `HeaderMismatch` checks will reject the call. After a dropped stream, the agent re-issues the call. heel's "repeats join the same request" rule (README) must therefore key on the call contents, not on the JSON-RPC id.
- **Gap.** For stdio upstreams speaking older revisions (2025-11-25 sessions and `initialize`), I have not re-checked compatibility details since the thread compacted. `basic/versioning.mdx` l.136 points to a stdio backward-compatibility section that should be read before implementation.

### 1.6 Authorization
- Authorization is OPTIONAL. "Implementations using an STDIO transport SHOULD NOT follow this specification, and instead retrieve credentials from the environment." **[spec]** S1 `basic/authorization/index.mdx` l.18–22.
- **Roles.** A protected MCP server is an OAuth 2.1 resource server, citing `draft-ietf-oauth-v2-1-13`. The client is an OAuth 2.1 client. Servers MUST implement RFC 9728 Protected Resource Metadata, and clients MUST use it for discovery. **[spec]** same file l.32–74.
- **Discovery flow.**
  1. The server answers `401` with `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"`, optionally with `scope`.
  2. The client fetches that metadata and discovers the authorization server.
  3. The client authorizes with PKCE and the RFC 8707 `resource` parameter, set to the canonical MCP server URI.
  4. The client sends `Authorization: Bearer <token>`. Tokens MUST NOT go in the query string.

  **[spec]** l.99–129, 151–178, 215–230, 259–278.
- **Audience.** Servers MUST validate that tokens were issued for them as the audience, and MUST answer `401` to invalid or expired tokens. **[spec]** token-handling section; `security-considerations.mdx` l.124.
- **2026-07-28 additions.** Authorization servers SHOULD send `iss` (RFC 9207), and clients MUST validate it. Clients MUST key credentials by issuer and MUST declare `application_type` in dynamic registration. **[spec]** S1 changelog minor changes 7–9.
- **How heel should authenticate agents** (inference from the above). heel's MCP endpoint is itself a protected resource:
  - Simple option: per-agent static bearer tokens minted by heel, sent as `Authorization: Bearer`. The spec only requires OAuth if heel claims spec-compliant authorization, and authorization itself is optional.
  - Full option: implement RFC 9728 metadata and act as, or delegate to, an authorization server, with heel's URL as the token audience.
  - Either way, heel must never accept a provider token, such as a Google OAuth token, from the agent. Facts 2 and 3 in §0 forbid that and the confused-deputy guidance in `security-considerations.mdx` l.107–124 warns against it.
- **Upstream side.** For remote servers like Google's Gmail MCP, heel is the OAuth client. Google requires its own OAuth client with "Use this client for an AI-powered agent" selected and scopes `gmail.readonly` and `gmail.compose`. **[API]** S4 configure guide.

### 1.7 Returning "pending approval with id" and "paused"
Options from the spec, with costs:

| Option | Spec basis | Works with every client? | Cost |
|---|---|---|---|
| **A. `isError: true` result** with text plus `structuredContent` such as `{status:"pending_approval", approval_id, retry:"same call"}` | Tool execution errors are meant for the model to act on (S1 tools.mdx l.763–785) | Yes | `structuredContent` should conform to the tool's `outputSchema` if one is advertised. heel would have to wrap or drop upstream output schemas, or rely on text only. |
| **B. Tasks extension** `CreateTaskResult` with status `working` or `input_required`, polled through `tasks/get` | SEP-2663, status Final. A server MUST NOT return `CreateTaskResult` unless the client sent the `io.modelcontextprotocol/tasks` capability *on that request*. Otherwise it must error with `-32021` (S1 `docs/seps/2663-tasks-extension.mdx` l.28, 111–125, 151–175) | Only clients that opt in | Natural fit for "check back with the id", but client support has to be detected per request. |
| **C. MRTR `InputRequiredResult`** with an `ElicitRequest` | Servers return `resultType:"input_required"` plus `inputRequests` and an opaque `requestState`. The client answers and retries (S1 `basic/patterns/mrtr.mdx` l.129–232) | Only clients that support elicitation | **Unsuitable as the approval itself.** The elicitation is answered *by the client that hosts the agent*. The approver must instead sign in on heel's page with a passkey (README). heel also MUST treat `requestState` as attacker-controlled (mrtr.mdx l.232). |
| **D. URL-mode elicitation** pointing to heel's approval page | URL mode is for "sensitive interactions that must not pass through the MCP client" (S1 `client/elicitation.mdx` l.15, 322–345) | Only clients that support elicitation | Could show the user a link. The approval still happens on heel's page, so this only helps with UX. Note the 2026-07-28 removals: `elicitationId` and the completion notification are gone, and correlation lives in `requestState` (changelog minor change 11). |

**Recommendation (inference).** Use A as the baseline for every client. Add B when the request declares the tasks capability. Use D only as an optional pointer. Never use C or D as the approval decision.
- **Paused:** an `isError: true` result with a stable machine code, for example `{error:"paused", scope:"agent|service|all"}`.
- **Unknown tool or malformed call:** JSON-RPC errors, per §1.2.
- **Cost of A:** a model may ignore the text, so the HTTP `202` and CLI exit-code paths in the README stay the deterministic channels.
- **What would reverse it:** broad client support for the tasks extension would make B the primary channel.

---

## 2. Email providers

### 2.1 Gmail API (S2 rev 20261106, S3)

**Methods (S2)**

| Method | HTTP | Notes |
|---|---|---|
| `messages.send` | POST `users/{userId}/messages/send` | "Sends … to the recipients in the `To`, `Cc`, and `Bcc` headers". Body is a Message with `raw`. Scopes include `gmail.send`, `gmail.compose`, `gmail.modify`, `mail.google.com/` and `gmail.send.self` |
| `drafts.create/update/get/list/delete` | POST/PUT/GET/GET/DELETE `drafts…` | `drafts.delete` "Immediately and permanently deletes … Does not simply trash it" |
| `drafts.send` | POST `drafts/send` | "Sends the specified, existing draft to the recipients in the To, Cc, and Bcc headers" |
| `messages.trash` / `untrash` | POST `messages/{id}/trash` | Reversible |
| `messages.delete` | DELETE `messages/{id}` | "Immediately and permanently deletes … cannot be undone" |
| `messages.batchDelete` | POST `messages/batchDelete` | "Provides no guarantees that messages were not already deleted or even existed". Scopes `mail.google.com/`, `gmail.messages`, `gmail.messages.delete` |
| `messages.batchModify` | POST `messages/batchModify` | ids: "limit of 1000 ids per request" |
| `messages.modify` | POST `messages/{id}/modify` | Add or remove labels |
| `threads.trash/delete/modify` | `threads/{id}/…` | Applies to every message in the thread ("Any messages that belong to the thread are also moved to the trash" / "also deleted") |
| `messages.import` / `insert` | POST | `insert` "Does not send a message" |
| `settings.sendAs.list` | GET | "includes the primary send-as address … as well as any custom 'from' aliases" |
| `settings.filters.create` | POST | Max 1,000 filters |
| `settings.forwardingAddresses.create`, `settings.updateAutoForwarding` | POST/PUT | "only available to service account clients that have been delegated domain-wide authority" |

There is **no archive method**: the S2 `messages` method list contains none. Inference: archive is `modify` or `batchModify` removing the `INBOX` label. Google's MCP models it the same way, with `unlabel_message` and `unlabel_thread` taking label ids (S4). I did not re-check google_workspace_mcp's archive path after the thread compacted.

**Response shapes (S2)**
- `messages.list` returns `{messages:[{id,threadId}], nextPageToken, resultSizeEstimate}`. "each message resource contains only an id and a threadId". It takes `q` (Gmail search syntax), `labelIds`, `maxResults` (default 100, max 500), `pageToken` and `includeSpamTrash`.
- `threads.get` returns `{messages:[Message]}` in order (S3 threads guide). `format` is one of `full`, `metadata` or `minimal`. With `metadata`, `metadataHeaders` restricts the headers returned.
- A Message has `id`, `threadId`, `labelIds`, `snippet`, `historyId`, `internalDate`, `payload` and `raw`. `raw` is the RFC 2822 message, base64url-encoded, returned with `format=RAW`.

**Reply and forward mechanics.** To add a message to a thread: "1. The requested `threadId` must be specified … 2. The `References` and `In-Reply-To` headers must be set in compliance with RFC 2822. 3. The `Subject` headers must match." **[API]** S2 `Message.threadId`. Sends carry the whole MIME message base64url-encoded in `raw` (S3 sending guide). Forward is not a separate API. It is a new `raw` message, with recipients in its headers.

**Batching.** Up to 100 calls per HTTP batch. Google recommends ≤50. The batch uses `multipart/mixed`, and each part is a nested HTTP request. "A set of n requests batched together counts toward your usage limit as n requests". **[API]** S3 batch guide.

**Implications for heel (inference)**
- `recipients` for `messages.send` and `drafts.create/update` come from decoding `raw` and parsing `To`, `Cc` and `Bcc`. Gmail sends to those headers (S2). A `Bcc` header must be counted.
- `drafts.send` requires `drafts.get(id, format=raw|metadata)` to read the stored recipients before rules run. The draft could also change between the check and the send, so heel should send the exact checked content, for example `messages.send` with the fetched `raw`, or deny. **Gap:** Gmail offers no conditional "send only if unchanged" for drafts.
- The `/batch/gmail/v1` endpoint must be parsed part by part, with each part checked and counted, or denied outright.

**What `all_in_thread` needs (Gmail)**
- **Inputs:** `threadId` from the call, or from `In-Reply-To` and `References` resolved by search. New messages without a `threadId` fail (README: "a new message isn't in a thread").
- **Lookup:** `threads.get(threadId, format=metadata, metadataHeaders=[From,To,Cc,Bcc])`.
- **Which messages count:** keep messages that are *yours*, meaning `labelIds` contains `SENT`, or `From` matches an address from `sendAs.list`. Inference: the `SENT` label is the standard system label, but S2 was not separately checked for its definition. The allowed set is the union of their To, Cc and Bcc. Every normalised recipient of the new call must be in that set, compared on lower-cased addr-spec.
- **Aliases:** `sendAs.list` is needed both to identify your messages and to validate any `From` alias the agent picks.

### 2.2 Outlook via Microsoft Graph v1.0 (S5, S6)

| Operation | Endpoint | Body and recipients | Response |
|---|---|---|---|
| Send new | POST `/me/sendMail` | JSON `{message:{toRecipients,ccRecipients,bccRecipients,…}, saveToSentItems}`, or MIME as base64 `text/plain` | `202`, empty. "doesn't indicate that the request processing has completed" |
| Reply | POST `/me/messages/{id}/reply` | `comment` *or* `message` (both together → 400). Goes to `replyTo` if set, else `from` | `202` |
| Reply all | POST `/me/messages/{id}/replyAll` | `comment`. "loads the sender and all recipients of the original message" | `202` |
| Forward | POST `/me/messages/{id}/forward` | `comment` plus `toRecipients` *or* `message.toRecipients` (both or neither → 400) | `202` |
| Send draft | POST `/me/messages/{id}/send` | No body (`Content-Length: 0`). The draft can be a new message, reply, reply-all or forward | `202` |
| Delete | DELETE `/me/messages/{id}` | none | `204` |
| Move | POST `/me/messages/{id}/move` `{destinationId}` | Folder id or well-known name (`deleteditems`, `archive`, `junkemail`…) | `201` + new message. "creates a new copy … and removes the original" |
| Permanent delete | POST `/users/{id}/messages/{id}/permanentDelete` | none. Global cloud only | `204` |
| Batch | POST `/$batch` | Up to 20 requests | per-request |

Permissions: send, reply, replyAll, forward and draft send need `Mail.Send`. Delete, move and permanentDelete need `Mail.ReadWrite`. (S5.)

The Message resource (S6) has `conversationId`, `conversationIndex`, `from`, `sender`, `replyTo`, `toRecipients`, `ccRecipients`, `bccRecipients`, `internetMessageId`, `isDraft` and `parentFolderId`.

**Implications for heel (inference)**
- Reply recipients = original `replyTo` if present, else `from`. Reply-all = original sender + `toRecipients` + `ccRecipients`. Both need a GET of the original message. Inference: whether Graph strips the user's own address and how it treats original `bccRecipients` is a **gap**, because S5 does not say.
- Draft send needs a GET of the draft's recipients, with the same check-then-send race as Gmail.
- MIME bodies on any of these endpoints must be decoded and parsed, or denied.
- Well-known folder names work "regardless of the locale" (S5 mailFolder). A move into `deleteditems` or `junkemail`, or into `recoverableitemsdeletions`, is `email.remove`. **Gap:** S5 `message-delete` does not say whether DELETE soft-deletes into Deleted Items or into Recoverable Items. Treat it as removal either way.
- **`all_in_thread` (Outlook).** Find messages with the same `conversationId` in `sentitems`, or messages whose `from` is the user, and union their recipient collections. **Gap:** I did not retrieve the exact `$filter` support for `conversationId` on `/me/messages` this session.

---

## 3. Popular MCP servers: tool names and argument shapes

### 3.1 Official GitHub MCP server (S7, `pkg/github/pullrequests.go`)
- **`merge_pull_request`.** Required: `owner`, `repo`, `pullNumber` (integer). Optional: `commit_title`, `commit_message`, `merge_method` (enum `merge`, `squash`, `rebase`) and `expectedHeadSha` ("The expected SHA of the pull request's HEAD ref"), which is passed as `SHA` to the merge call. `ReadOnlyHint: false`. It returns `{sha, merged, message}`.
- **`update_pull_request_branch`** also takes `expectedHeadSha`.
- **`pull_request_read`** method enum: `get`, `get_diff`, `get_status`, `get_files`, `get_commits`, `get_review_comments`, `get_reviews`, `get_comments`, `get_check_runs`.
- **Mapping:** `github.merge` ← `merge_pull_request`. heel should **set** `expectedHeadSha` to the head SHA it checked, overwriting any agent value.

### 3.2 Google's official Gmail MCP server (Developer Preview) (S4)
- Endpoint `https://gmailmcp.googleapis.com/mcp/v1`. Tools: `create_draft`, `get_message`, `get_thread`, `label_message`, `label_thread`, `list_drafts`, `list_labels`, `search_threads`, `unlabel_message`, `unlabel_thread`. **No send tool.**
- `create_draft`: `to[]`, `cc[]`, `bcc[]`. Each entry "MUST be a valid plain email address", and the `"Name email"` form is "NOT supported". Also `subject`, `body`, `htmlBody`, `replyToMessageId` and `attachments[]`. It returns only the draft `id`.
- `label_message`: `{messageId, labelIds[]}`. "To add a trash label or a spam label … please use the `apply_sensitive_message_label` tool instead". That tool is *not* in the reference page's tool list. **Gap:** its schema and availability.
- OAuth scopes: `gmail.readonly` and `gmail.compose`. Inference: per S2, `gmail.compose` is one of the scopes `messages.send` accepts. The grant can therefore send even though the tool list cannot.
- **Mapping:** `create_draft` is not `email.send`. `unlabel_*` removing `INBOX` is archive, i.e. `email.remove`. `apply_sensitive_message_label` with `TRASH` or `SPAM` is `email.remove`.

### 3.3 taylorwilsdon/google_workspace_mcp (S9)
Gmail tools: `search_gmail_messages`, `get_gmail_message_content`, `get_gmail_messages_content_batch`, `get_gmail_attachment_content`, `send_gmail_message`, `draft_gmail_message`, `get_gmail_thread_content`, `get_gmail_threads_content_batch`, `list_gmail_labels`, `manage_gmail_label`, `list_gmail_filters`, `manage_gmail_filter`, `modify_gmail_message_labels`, `batch_modify_gmail_message_labels`.
- **`send_gmail_message`** covers new messages, replies and forwards in one tool.
  - `user_google_email` selects the account.
  - `to`: "Recipient email address. Optional when replying with reply_all=True, which derives it from the thread."
  - `cc` and `bcc`: "Optional CC email address." / "Optional BCC email address." (strings).
  - `from_email`: "'Send As' alias … Must be configured in Gmail settings".
  - `thread_id`, `in_reply_to`, `references`, `reply_all`.
  - `forward_message_id`, which forwards that message, plus `include_forwarded_attachments` and `attachments`.
- `modify_gmail_message_labels(message_id, add_label_ids, remove_label_ids)`.
- `batch_modify_gmail_message_labels(message_ids, add_label_ids, remove_label_ids, verify, thread_ids)`. Item count = message ids + messages in each thread id, which needs `threads.get`.
- **Gap:** whether `to`, `cc` and `bcc` accept comma-separated lists. The source descriptions use the singular, and no `getaddresses` or `split(',')` call appears in `gmail_tools.py`. Recipient parsing may live in a helper module I did not inspect.

### 3.4 GongRzhe/Gmail-MCP-Server (S10)
Tools: `send_email`, `draft_email`, `read_email`, `search_emails`, `modify_email`, `delete_email` ("Permanently deletes an email"), `list_email_labels`, `batch_modify_emails`, `batch_delete_emails` ("Permanently deletes multiple emails in batches"), `create_label`, `update_label`, `delete_label`, `get_or_create_label`, `create_filter`, `list_filters`, `get_filter`, `delete_filter`, `create_filter_from_template`, `download_attachment`.
- **Send and draft schema:** `to: string[]`, `cc?: string[]`, `bcc?: string[]`, `threadId?`, `inReplyTo?`, subject and body.
- **Label schemas:** `modify_email {messageId, labelIds?, addLabelIds?, removeLabelIds?}`, `batch_modify_emails {messageIds[], addLabelIds?, removeLabelIds?, batchSize=50}` and `batch_delete_emails {messageIds[], batchSize=50}`. Item count = `messageIds.length`, independent of `batchSize`.
- **`create_filter`** has an action field `forward: "Email address to forward matching emails to"`. Inference: this creates persistent forwarding, an `email.send`-like exfiltration path. S2 says forwarding addresses can only be *created* by domain-wide-delegated service accounts. A filter can still use an already verified forwarding address. Map filter creation with `forward` to a sensitive action that is denied by default.

### 3.5 ryaker/outlook-mcp (S11)
Tools: `list-emails`, `search-emails`, `read-email`, `send-email`, `draft-email`, `mark-as-read`, `delete-email`, `list-folders`, `create-folder`, `move-emails`, `list-rules`, `create-rule`, `edit-rule-sequence`.
- `send-email`: `to` (required, "Comma-separated list"), `cc` and `bcc` (comma-separated), `subject`, `body`, and options for HTML, importance and saving to Sent Items. The code splits with a naive `to.split(',')` (`email/send.js` l.49–67). Inference: `"Doe, John" <j@x>` would split wrongly. heel's normaliser must match the *server's* parse, or reject display-name forms. Otherwise heel checks a different address set from the one the server sends to.
- `delete-email {id, permanent?}` moves to `deleteditems`, or calls `permanentDelete` when `permanent=true` (`email/delete.js` l.25–34).
- `move-emails {emailIds (comma-separated), targetFolder (folder *name*), sourceFolder?}`. Inference: the target is a display name, not a Graph well-known name. Display names are localised, so "is this a removal?" needs heel to resolve the name to an id first. This is a **gap** in deterministic mapping.
- `create-rule` exposes `moveToFolder` and `markAsRead`, but no forward action in its schema. `rules/list.js` reads `forwardTo` only to display it.

### 3.6 Normalisation rules (inference from 3.1–3.5)
- **`recipients`** = parsed addr-specs from to ∪ cc ∪ bcc, plus derived recipients for reply, reply-all, forward and draft send (§2). Shapes differ: arrays of strings (S10, S4), comma-separated strings (S11), single strings with `reply_all` derivation (S9), and raw MIME (Gmail REST). Display-name forms are rejected by Google's MCP (S4).
- **`email.send`** includes send, reply, reply-all, forward and draft send. It also includes filter or rule creation with a forward action.
- **`email.remove`** includes trash, delete, batch delete, label add of TRASH or SPAM, removal of INBOX (archive), and a move to `deleteditems`, `junkemail` or `archive`.
- **`items`** = number of resolved message ids after expanding threads.

---

## 4. GitHub merge and `checks: passing`

- **Sync merge.** `PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge` takes `commit_title`, `commit_message`, `sha` ("SHA that pull request head must match to allow merge") and `merge_method`. Responses: `200` merged, `405` cannot merge, **`409` "if sha was provided and pull request head did not match"**, plus `422`, `403` and `404`. The description notes: "We recommend using the asynchronous merge API … This endpoint does not support stacked pull requests or merging with a merge queue." **[API]** S8.
- **Async merge.** `PUT …/merge-async` takes `bypass_rules`, `commit_message`, `commit_title`, `merge_action`, `merge_method` and `sha`. It returns `202` with a UUID. Use `GET …/merge-async/{uuid}` to fetch the result. While pending, the response includes the "expected head SHA". Merging a stacked PR includes all open downstack PRs. The call may add the PR to a merge queue. **[API]** S8. Inference: `bypass_rules` must be its own denied-by-default condition. Queued is not merged.
- **Combined status.** `GET /repos/{owner}/{repo}/commits/{ref}/status`: `state` is **failure** if any context is error or failure, **pending** "if there are no statuses or a context is pending", and **success** if the latest status of every context is success. **[API]** S8.
- **Check runs.** `GET /repos/{owner}/{repo}/commits/{ref}/check-runs` takes `check_name`, `status`, `filter` (`latest` returns the most recent check runs) and `app_id`, and is paged. It limits to the 1000 most recent check suites. Check runs from forks are not linked to `pull_requests`. Conclusion enum: `success`, `failure`, `neutral`, `cancelled`, `skipped`, `timed_out`, `action_required`. **[API]** S8.
- **Required checks.** `GET /repos/{owner}/{repo}/rules/branches/{branch}` returns rules. A `required_status_checks` rule has the parameters `required_status_checks`, `strict_required_status_checks_policy` and `do_not_enforce_on_create`. **[API]** S8. **Gap:** classic branch-protection required contexts were not re-checked this session.
- **gh CLI equivalent:** `gh pr merge --match-head-commit <SHA>`. It also has `--admin` ("merge a pull request that does not meet requirements") and `--auto`. **[API]** S12.

**Race-free evaluation (inference)**
1. GET the PR and record `head.sha` = H.
2. Read combined status for H and check runs for H, using `filter=latest` and paging to the end. Statuses and check runs are separate systems. A repo with only Actions has *no statuses*, so combined `state` would read `pending`. Do not require `state == success` when there are no statuses.
3. Pass when every required check (from rules), or every reported run if required checks are unknown, has `status: completed` with an allowed conclusion, and no status context is `failure` or `error`. Whether `neutral` and `skipped` count as passing is a policy choice heel should state.
4. Merge with `sha=H` (REST), `expectedHeadSha=H` (MCP) or `--match-head-commit H` (gh). A `409` means "head moved". Report it as a rule failure, not a server error.
5. Deny `--admin`, `bypass_rules` and `--auto` under `checks: passing`. Each defeats the check.

---

## 5. CLI parsing: `gh` and `kubectl`

### 5.1 kubectl
- **Syntax:** `kubectl [command] [TYPE] [NAME] [flags]`. Command-line flags override defaults and environment variables. In-cluster auth and `POD_NAMESPACE` change the default namespace. **[API]** S13 overview.
- **Global flags** are registered on the root command as **persistent flags**: `flags := cmds.PersistentFlags()` (S14 `cmd.go` l.218). They include `-n/--namespace`, `--context`, `--cluster`, `--user`, `--kubeconfig`, `-s/--server`, `--token`, `--as`, `--as-group`, `--as-uid`, `--kuberc`, `--insecure-skip-tls-verify`, `--password` and `--username`. (S13 `kubectl` page.)
- **How cobra finds the verb** (`stripFlags`, S14 `command.go` l.674–704):
  - `--` ends the flags.
  - `--flag value` and `-f value` consume the next argument unless the flag takes no value.
  - `--flag=value` is a single token.

  Inference: to find the verb in `kubectl -n prod delete pod x`, heel must know which global flags take values. Skipping every token that starts with `-` would treat `prod` as the verb. kubectl's own plugin lookup takes the "first non-flag" argument (S14 `cmd.go` l.122–127), so it is not a safe model to copy. heel should use a full table of kubectl global flags and their arity. Unknown flags should be denied.
- **Plugins.** An unknown command runs an executable `kubectl-<name>` from `PATH`, with all args and environment passed through. Plugins cannot override built-in commands. `kubectl create <x>` may dispatch to `kubectl-create-x`. **[API]** S13 plugins page; S14 l.107–157. Inference: deny unknown verbs, or run kubectl with a controlled `PATH`.
- **kuberc.** `~/.kube/kuberc`, `--kuberc` or `KUBERC` define **aliases** (`name`, `command`, `options`, `prependArgs`, `appendArgs`) and **defaults** (default flag values). `KUBECTL_KUBERC=false` disables it. **[API]** S13 kuberc page. Inference: heel should set `KUBECTL_KUBERC=false` and reject `--kuberc`, so the parsed argv is the executed argv.
- **Commands that print credentials:**
  - `kubectl config view --raw`: "Display raw byte data and sensitive data". `--flatten` produces self-contained output, and `-o jsonpath='{.users[…].user.password}'` is a documented example. (S13 config view.) Inference: `--flatten` embeds certificate data.
  - `kubectl create token SA`: "Request a service account token" (S13).
  - **Inference, not documented in a fetched source:** `kubectl get secret -o yaml/json/jsonpath`, `kubectl describe secret`, `kubectl exec … cat /var/run/secrets/...`, `kubectl proxy` and `kubectl port-forward` expose credentials or the API. Treat them as sensitive by default.

### 5.2 gh
- **Structure:** `gh <command> <subcommand> [flags]`. Per-command inherited flags such as `-R/--repo [HOST/]OWNER/REPO` appear under "Options inherited from parent commands" on `gh pr merge` and `gh secret`. **[API]** S12. **Gap:** I found no gh page listing root-level global flags that may precede the command. heel should only accept flags after the command path and deny anything else.
- **Environment that changes the target:** `GH_TOKEN` and `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GH_HOST`, `GH_REPO`, `GH_CONFIG_DIR`, and `GH_DEBUG=api`, which logs HTTP traffic. **[API]** S12 environment. Inference: heel must set or scrub these. With `GH_DEBUG=api`, request details go to stderr, and those can include auth headers. Not verified.
- **Aliases.** `gh alias set` expands a word into a full command. If the expansion starts with `!` or uses `--shell`, it "will be evaluated through the `sh` interpreter". **[API]** S12. Inference: deny any argv whose first word is not a built-in gh command, or use an empty `GH_CONFIG_DIR` holding only hosts and auth.
- **Extensions.** Repos named `gh-*` provide commands, and all arguments are forwarded to the extension executable. Extensions cannot override core commands. **[API]** S12.
- **Commands that print credentials:**
  - `gh auth token` "outputs the authentication token" and auto-refreshes it unless `--no-refresh` is given.
  - `gh auth status -t/--show-token` displays the token, including with `--json hosts --show-token`.

  **[API]** S12.
- **`gh api` is a raw escape hatch** to any REST or GraphQL endpoint. It defaults to POST when fields are given and supports `-X`, `--input` and `--paginate`. **[API]** S12. Inference: `gh api` bypasses any verb-level mapping such as `pr merge`. Deny it by default, or map it as an HTTP call against GitHub's OpenAPI.

---

## 6. Password-reset and login-code detection (`looks_like`)

**What exists**
- **Standard format, SMS only.** WICG origin-bound one-time codes define a message format binding a code to an origin. The format is detailed in §3 of that spec, which I did not fetch past the opening. It "does not impose any requirements … on the use of one-time codes which are not origin-bound". The introduction says heuristic extraction "has to rely on heuristics, which are often unreliable and error-prone". **[spec]** S15. Inference: useful as a high-precision positive signal (`@domain #code` lines), but absent from most email.
- **MessAuto** (Rust, MIT). Detects the keyword set `验证码`, `动态密码`, `验证`, `代码`, `verification code`, `captcha code`, `verification`, `captcha`, `code` and `인증`, then extracts with `(?=[a-zA-Z0-9-]*[0-9])[a-zA-Z0-9-]{4,8}`. It picks the candidate nearest the keyword. **[repo]** S16 `src/config.rs` l.71–83 and `src/parser.rs`.
- **otphelper** (Kotlin, AGPL-3.0). Uses `sensitivePhrases` (`code`, `One[-\s]Time[-\s]Password`, `\bOTP\W`, `\b2FA\W` and Persian terms) and `ignoredPhrases` (discount words, `off`, `RatingCode`, …). A combined regex excludes currency-adjacent numbers. **[repo]** S16 `utils/CodeExtractor.kt` l.21–131. Note: its AGPL licence is incompatible with copying into Apache-2.0 heel. Use it as reference only.
- **parse-otp-message** (JS, last commit 2020). Auth-word list (`auth`, `login`, `activation`, `verification`, `confirmation`, `access code`, `code`, `pin`, `otp`, `security`, `2-step`, `2-factor`, …) plus an 87-line known-services table. **[repo]** S16 `lib/auth-words.js`, `lib/known-services.js`.
- All three target **codes**. None covers **password-reset links**. **Gap:** I found no maintained open-source reset-link detector or labelled dataset.

**Recommended design (inference)**
1. **Patterns first, for recall.**
   - Keyword sets for codes (above) and for resets: "reset your password", "password reset", "forgot password", and magic-link phrasing such as "sign in to", "log in with this link".
   - Code regex near a keyword.
   - URL heuristics: paths or queries containing `reset`, `password`, `token=`, `magic`, `login`, `verify`, `otp`.
   - WICG `@origin #code` lines.
2. **Classifier for the rest.** Use a small local model on subject plus the first N characters of the body. **Gap:** I found no published small classifier for this task. One would have to be trained or prompted, and its accuracy is unknown.
3. **Fail closed.** If patterns match, hide. If the classifier errors, times out, is unavailable or is uncertain, hide. If the message cannot be parsed (encrypted, S/MIME, or an image-only body), hide.
4. **Hide all copies.** Hiding must cover the snippet as well as the body. Gmail `messages.list` returns only ids, but `snippet`, thread previews and `search_*` results carry text (S2 Message `snippet`). Hide every field and every copy, including the MCP structured and text mirrors from §1.3.
5. **Cost.** Recall-first patterns will hide ordinary mail containing "code". Accept that, since false negatives leak account takeovers. Measure the false-positive rate on a real inbox before tuning.

---

## 7. Gaps (no reliable source found or not re-checked)

1. Gmail: there is no conditional or atomic "send this draft only if unchanged". The `drafts.get` → send race is unsolved by the API.
2. Graph: whether `reply` and `replyAll` exclude the user's own address and original Bcc. The exact `$filter` support for `conversationId`. Whether DELETE soft-deletes into Deleted Items or Recoverable Items.
3. Google Gmail MCP: the `apply_sensitive_message_label` tool is referenced but not listed. Its schema is unknown, and the server is in Developer Preview.
4. google_workspace_mcp: whether `to`, `cc` and `bcc` accept multiple comma-separated addresses.
5. ryaker/outlook-mcp: `move-emails` targets folder display names, which are localised. Mapping to a removal needs heel's own folder lookup.
6. gh: no documented list of root-level flags allowed before the command. Whether `GH_DEBUG=api` output includes the Authorization header is unverified.
7. MCP: stdio backward-compatibility details for pre-2026-07-28 servers were not re-read after the thread compacted. Client adoption of the tasks extension and of URL-mode elicitation is unknown, since no source was consulted.
8. GitHub: classic branch-protection required-check contexts were not re-checked. Only rulesets (`rules/branches/{branch}`) were.
9. `looks_like`: no maintained reset-link detector, no labelled dataset and no published small classifier. Accuracy is unmeasured.
10. MCP server popularity ranking: the earlier GitHub search was not re-run after the thread compacted.
