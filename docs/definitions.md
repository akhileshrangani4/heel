# Built-in services, and your own

[README](../README.md) · [Quickstart](quickstart.md) · [Connect accounts](connect.md) · [Connect your agent](agents.md) · [Rules](rules.md) · [Approvals](approvals.md) · [Running](running.md)

heel ships definitions for Gmail, Outlook, Google Calendar, GitHub, Slack, Linear, Notion and Stripe. A definition is ordinary code that says, for each tool an agent can call, what the call means. Nothing about them is special: this page shows what one does, why it gives you better rules than putting a raw MCP server behind heel, and how to get most of the same for your own API today.

## What a definition does

Every tool in a definition has the same parts. Here is Notion's `create_page`, from [`src/definitions/notion/definition.ts`](../src/definitions/notion/definition.ts), trimmed:

```ts
create_page: tool({
  description: "Create a page under another page, with a title and plain paragraphs.",
  args: z.strictObject({ parent_page_id: Id, title: Title, paragraphs: Paragraphs.optional() }),
  readOnly: false,
  prepare: async (box, args, _h, signal) => {
    // The parent must be there, and readable: a missing one is not available.
    await pageWithParent(box, args.parent_page_id, signal);
    return { args, action: "notion.page.create", fields: { parent: args.parent_page_id } };
  },
  run: (box, a, signal) => box.client.request("POST", "/v1/pages", signal, { /* ... */ }),
  show: async (_box, page) => shownPage(page),
}),
```

| Part | What it does | What it gives your rules |
| --- | --- | --- |
| `args` | A strict schema for the arguments. Anything else is refused before rules run. | Rules match the arguments that will actually be sent, never extra fields an upstream might also read. |
| `readOnly` | Whether the tool can change anything. | `kind: read` or `kind: write`, so "allow every read" is one rule. |
| `prepare` | Runs before any rule. It can read from the service (here: is the parent page there?) and names the call. | An `action` shared across services (`notion.page.create`, `email.send`), plus fields such as `parent`, `recipients` or `repo` that the raw arguments don't spell out. A failed read denies the call. |
| `persistence` | Set by `prepare` for calls that leave something behind after you revoke heel: forwarding rules, workflows, deploy keys. | Only a rule that names the call can allow it; a broad allow never does. |
| `run` | Sends the call, with the credential heel holds. | The agent never sees the credential. |
| `show` | Shapes what comes back. | The agent gets what it needs, not every field the API returns, and hidden mail never reaches it. |

## Why this beats a raw MCP server

You can put any MCP server behind heel with `heel connect mcp`, and heel checks every call to it. But heel doesn't know what that server's tools do, so your rules are limited to what the agent sent:

| | A built-in definition | A raw MCP server behind heel |
| --- | --- | --- |
| What rules match on | `action`, `kind`, `recipients`, `repo`, `parent`, `channel`, `amount` ... worked out by heel | `tool` and `args.*`, as the agent sent them |
| "Allow every read" | `kind: read` | List each read tool by name |
| Same rule across services | `action: email.send` covers Gmail and Outlook | One rule per server and tool |
| Checks against the service | Reads first: is this a reply in an existing thread? is CI green? who are the recipients? | None: heel can't read the service for a tool it doesn't understand |
| Calls that outlive heel | Marked, and refused unless a rule names them | Not known, so a broad allow covers them |
| Hiding mail | Hidden items never reach the agent | Not possible; heel can allow or deny, not filter what comes back |
| What the approver reads | A plain summary: "send an email to Bob and 40 others at vendor.com" | The tool name and its JSON arguments |
| The credential | Held by heel | For a remote server, sent by heel; for a local server, kept outside its sandbox when you name its hosts ([Running](sandbox.md#credentials-stay-outside-the-sandbox)) |

A raw MCP server is still useful: it gets you heel's approvals, pause, audit and counts on day one. When a service matters, a definition is what lets your rules say what you mean.

## Your own API, the same way

You can't add code to heel without changing heel itself, but for an HTTP API you can get most of a definition without code: connect it as an HTTP account and describe it in an OpenAPI file with three heel keys on each operation.

| Key | Value | What it gives your rules |
| --- | --- | --- |
| `x-heel-action` | A name like `tickets.close` (lower case, at least one dot) | `action: tickets.close`, the same way built-ins have `email.send` |
| `x-heel-kind` | `read` or `write` | `kind: read`. Only an explicit `read` counts; an operation without it is never a read. |
| `x-heel-hide` | Where email-shaped items sit in the response (only on `read` operations) | Your `hide` entries apply to this API's responses too ([Hiding](rules-reference.md#hiding)) |

```yaml title="tickets-openapi.yaml"
openapi: 3.1.0
info: { title: Tickets, version: "1" }
paths:
  /tickets:
    get:
      operationId: listTickets
      x-heel-action: tickets.read
      x-heel-kind: read
  /tickets/{id}:
    get:
      operationId: getTicket
      x-heel-action: tickets.read
      x-heel-kind: read
  /tickets/{id}/close:
    post:
      operationId: closeTicket
      x-heel-action: tickets.close
      x-heel-kind: write
```

Connect it, with the API token on stdin:

```sh
printf %s "$TICKETS_TOKEN" | heel connect http --as tickets \
  --base-url https://tickets.example.com/api --openapi tickets-openapi.yaml \
  --auth bearer --credential-stdin
```

Agents then call `/http/tickets/tickets/42/close` on heel's agent port, and your rules can say what you mean:

```yaml title="rules/owner.yaml"
rules:
  - name: ticket-reads
    match: { account: tickets, kind: read }
    then: allow
  - name: closing-asks
    match: { account: tickets, action: tickets.close }
    then: ask
```

Calls to paths the file doesn't describe still go through heel, but with no `action` or `kind`; a rule on `method` and `path` covers them. The [rules reference](rules-reference.md#http-accounts) has every key an HTTP account's rules can match.

What you don't get this way is what needs code: reading the service before a rule decides (the thread, the CI status, a page's parent), fields worked out from the arguments, and a plain summary on the approval page. Those are what a built-in definition adds.

## Adding a built-in

A built-in is a folder under [`src/definitions/`](../src/definitions/): a `definition.ts` with its tools, a small API client, and tests. Notion's is about 400 lines and a good one to copy. [CONTRIBUTING](../CONTRIBUTING.md) has how to build and test heel.
