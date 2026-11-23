# heel: notes for coding agents

heel is a self-hosted permission gateway. It sits between AI agents and a person's accounts, holds the credentials, and checks every call against rules on the call's actual arguments. Calls either run, wait for the owner to approve them with a passkey, or never run. [CONTRIBUTING.md](CONTRIBUTING.md) covers how to run, test and release it. This file covers what you need to know before you change it.

## Run and check

Use Node 26.13 or later and pnpm 12. A checkout runs the TypeScript source directly, with no build step. Before you open a PR, run what CI runs:

```sh
pnpm lint && pnpm typecheck && pnpm test && pnpm test:invariants
```

Also run whichever of these your change touches: `pnpm test:e2e`, `pnpm test:browser` (the approval page), `pnpm db:drift`, `pnpm schema:drift`, `pnpm ui-css:drift`.

## Where things are

| Path | What |
| --- | --- |
| `src/core/` | The call model: rules, counts, approvals, hiding, call hashes |
| `src/gateway/` | What agents talk to: MCP server (`mcp/`), HTTP proxy, `heel run`, agent tokens |
| `src/web/` | The owner's web UI: routes, passkeys, sessions. Pages are in `src/web/ui/` |
| `src/definitions/` | Built-in services (GitHub, Gmail, Slack and others): tools, actions, fields |
| `src/store/` | SQLite through Drizzle; schema in `schema.ts`, migrations in `migrations/` |
| `src/cli/` | The `heel` command |
| `skills/heel/SKILL.md` | The skill agents install to work through heel |
| `docs/*.md` | The user docs, published at useheel.dev by `docs/site` |
| `docs/design/` | The original spec and research (not published) |

## Rules that don't bend

- **Rules decide every call, never a model.** A model may hide content (`looks_like`, which hides when unsure) or add hints to the approval page. It never allows a call.
- **Fail closed.** No matching rule, an error, a timeout or heel being down all mean denied.
- **Credentials never leave heel.** They are not logged, not returned to an agent and not put in errors or the audit log.
- **Deciding needs a passkey** bound to the exact call (I-56). The approval page shows the full arguments and never truncates them (I-57). The pending list has no approve or deny controls.
- **Invariants:** `test/invariants.ts` lists them (I-xx). A change that touches one needs a test tagged with its id in the title, such as `it("I-10: denies a call no rule matches", …)`. Never remove an invariant.

## Generated files: regenerate, don't edit

| File | Command |
| --- | --- |
| `src/web/ui/styles/tailwind.ts` | `pnpm gen:ui-css` (from `scripts/ui/tailwind.css`) |
| `schema/heel-rules.schema.json` | `pnpm gen:schema` |
| `docs/rules-reference.md` service tables | `pnpm gen:rules-reference` |
| `src/store/migrations/` | `pnpm db:generate` after editing `src/store/schema.ts` |
| `src/definitions/cli/generated/` | `pnpm gen:cli-tables` |
| `src/lookslike/weights.json` | `pnpm gen:looks-like` |

## The web UI

- Pages are server-rendered with Hono's `html` templates. There is no React.
- Buttons, dropdowns and tables use shadcn/ui's Tailwind classes through the cva helpers in `src/web/ui/shadcn/`. After changing a class there or in `scripts/ui/tailwind.css`, run `pnpm gen:ui-css`.
- A passkey button (`data-heel-ceremony`) only works if its route passes `clientScript(csrfToken)` to `renderPage`.
- `pnpm ui:preview` serves every page and state with fixture data, at desktop and phone sizes. Check both, and dark mode.
- After a visible change, run `pnpm docs:screenshots` and update the README phones in `assets/readme/`.

## Docs and agent-facing text

- There are 12 pages in four groups. The sidebar order is `GROUPS` in `docs/site/scripts/sync.mjs`. A page's first sentence becomes its description and its `llms.txt` entry, so make it say what the page is for.
- Each page covers one task, in plain words. Keep pages short, show what the user will see, and keep the reference material separate.
- If you rename or remove a page, add a redirect in `docs/site/next.config.mjs`. Old URLs must keep working.
- The setup prompt, served at useheel.dev/setup.md, lives in `src/gateway/mcp/setup-prompt.ts` and is copied whole into `docs/quickstart.md` under "The prompt". Change both together; `pnpm test` fails if they differ.
- When you change how agents work through heel (approvals, denials, asking for a connection), update `skills/heel/SKILL.md`.
- When you add a script, a CI step or a new place something lives, update CONTRIBUTING.md in the same PR.
- Never use em dashes, in code comments, UI copy, docs or commit messages.

## PRs

- One change per PR. PRs are squash-merged, and the title becomes a conventional commit that release-please reads (`feat:`, `fix:`, `docs:` and so on). See CONTRIBUTING.md.
- A roadmap item changes `docs/site/app/(home)/roadmap/page.tsx` (`started` or `shipped`) in the same PR.
- Never merge the release PR, `chore(main): release <version>`. Merging it publishes to npm.
