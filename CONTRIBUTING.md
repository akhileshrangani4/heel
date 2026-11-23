# Contributing to heel

How to work on heel itself: running it from a checkout, the checks CI runs, PR titles, and how releases are made. To use heel, see the [README](README.md) and [useheel.dev](https://useheel.dev).

## Run it from a checkout

Node 26.13 or later and pnpm. A checkout runs the TypeScript source directly, with no build step:

```sh
pnpm install
export HEEL_HOME=~/.heel-dev
node bin/heel.js vault init
node bin/heel.js serve
```

## Checks

CI runs all of these on every PR:

```sh
pnpm lint            # Biome
pnpm typecheck       # tsc
pnpm test            # unit and integration tests
pnpm test:e2e        # end-to-end, including the incident replays
pnpm test:invariants
pnpm db:drift        # migrations match the schema (after a schema change: pnpm db:generate)
pnpm schema:drift    # the rules JSON Schema matches the Zod schema
pnpm ui-css:drift    # the committed web UI stylesheet matches scripts/ui/tailwind.css
pnpm test:browser    # the approval page in a real browser
pnpm package:smoke   # the npm package installs and serves
```

- **The docs site:** it's in [`docs/site`](docs/site/README.md) and builds from the README and `docs/*.md`.
- **The rules reference:** every example in [`docs/rules-reference.md`](docs/rules-reference.md) is run by `pnpm test`, and its built-in service tables come from the definitions. After changing a built-in tool, run `pnpm gen:rules-reference` (and update its entry in `scripts/lib/rules-reference.ts` if the test asks).
- **The setup prompt:** the prompt an agent reads at useheel.dev/setup.md lives in `src/gateway/mcp/setup-prompt.ts`, and `docs/quickstart.md` prints it whole under "The prompt". Change the code, then paste it into the quickstart; `pnpm test` fails until they match.
- **The web UI:** pages are server-rendered HTML in `src/web/ui/`, styled with shadcn/ui's Tailwind classes (`src/web/ui/shadcn/`) and no React. After changing a class or `scripts/ui/tailwind.css`, run `pnpm gen:ui-css`. `pnpm ui:preview` serves every page and state with fixture data at desktop and phone sizes.
- **Screenshots:** after a UI change, run `pnpm docs:screenshots` to regenerate `docs/images/`, and update the README phones in `assets/readme/` too.

## PR titles

PRs are squash-merged, and the title becomes the commit that release-please reads to choose the next version. Use a conventional title: `feat: …`, `fix: …`, `docs: …`, `ci: …`, `chore: …`, `test: …` or `refactor: …`, with an optional scope (`feat(approvals): …`). The table under [Making a release](#making-a-release) shows which types release what.

## Releases

A release happens when you merge a release PR. Nothing is published before that.

### Making a release

1. **Merge PRs with conventional titles.** PRs are squash-merged, so the PR title becomes the commit that [release-please](https://github.com/googleapis/release-please) reads:

   | Title | Next version |
   | --- | --- |
   | `fix: …` | patch: 0.2.0 to 0.2.1 |
   | `feat: …` | patch before 1.0.0 (0.2.0 to 0.2.1); minor from 1.0.0 on |
   | `feat!: …`, or a `BREAKING CHANGE:` footer | minor before 1.0.0 (0.2.0 to 0.3.0); major from 1.0.0 on |
   | `docs:` | no release on its own; listed under **Documentation** in the next one |
   | `ci:`, `chore:`, `test:`, `refactor:` | no release on their own, and not in the changelog |

2. **The release PR updates itself.** After CI passes on `main`, release-please opens or updates a PR titled `chore(main): release <version>`. It bumps `version` in `package.json` and adds the release to `CHANGELOG.md`. The PR is opened from the repository owner's account, so CI runs on it.
3. **Merge the release PR.** That is the release. release-please tags `v<version>` and creates the GitHub release, then [`.github/workflows/release.yml`](.github/workflows/release.yml) publishes it (see below).

To release a version other than the one it proposes, put `Release-As: 1.0.0` in the body of a commit merged to `main`.

### What the release workflow does

| Job | Access | What it does |
| --- | --- | --- |
| `release-pr` | contents, PRs | release-please: opens or updates the release PR. After a release PR merges, it creates the tag and GitHub release. |
| `plan` | read | Publishes only a version that has a GitHub release, and only from the commit that tag points at. For npm and ghcr.io separately, checks whether that version is already published. |
| `build` | read only, no publish credentials | Installs, runs `pnpm package:smoke` (packs heel, installs the tarball with npm into an empty project, and checks that it starts, answers on both planes and accepts admin commands), packs the tarball and builds the image. |
| `npm` | npm publish only | Publishes the tarball `build` made, with provenance. Installs nothing. |
| `ghcr` | packages | Pushes the image `build` made, as `:<version>` and `:latest`. Installs nothing. |
| `docs` | read; the Vercel token | Deploys [useheel.dev](https://useheel.dev) from the released commit, once npm has the release ([`docs.yml`](.github/workflows/docs.yml)). Skipped for a pre-release. |
| `notes` | contents | Adds install lines to the GitHub release. |

- **Re-running:** each publish checks whether it's already done, so if a run fails you can re-run it to finish.
- **`latest`:** only ever moves to a higher version, on npm and on ghcr.io. A pre-release version (`1.2.0-rc.1`) goes to npm's `next` tag instead.
- **The docs site follows releases:** useheel.dev only changes when a release goes out, so it never documents a version that isn't on npm. To redeploy it, run the `docs` workflow from the Actions tab. By default it deploys the latest release tag; give it `main` to ship a fix to the site itself early.
- **Registry errors:** an error from npm or ghcr.io stops the run. It's never treated as "not published yet".

### The npm package

The package is called `useheel`, and installing it gives you the `heel` command.

- **Compiled:** Node won't strip types inside `node_modules`, so the package ships `src` compiled to `dist`. `pnpm build` does this, and `prepack` runs it.
- **Same layout:** `dist` keeps `src`'s layout. The data files `src` reads at runtime, like the looks_like weights and the migrations, are copied beside the compiled modules.
- **Which code runs:** `bin/heel.js` runs `src` when it's there (a checkout or the OCI image) and `dist` otherwise.
- **Checked on every PR:** the `npm package installs and serves` CI job runs the smoke test.

### Setup

These are needed once per repository:

| What | Where | Why |
| --- | --- | --- |
| `RELEASE_TOKEN` | Repository secret: a fine-grained GitHub token for this repository with read and write access to **Contents** and **Pull requests** | Release PRs are opened from your account, so CI runs on them. With the default token they're opened by `github-actions[bot]`, and CI doesn't run. |
| npm trusted publisher | npmjs.com, `useheel` package settings: GitHub Actions, `akhileshrangani4/heel`, workflow `release.yml`, no environment | npm accepts publishes from the workflow with no stored token. |
| `NPM_TOKEN` (first release only) | Repository secret: a granular npm token that can publish | npm doesn't allow a trusted publisher before the package exists. After the first release, add the trusted publisher, then delete this secret and revoke the token. |
| Vercel project | Vercel: project `useheel` on your personal team, Root Directory `docs/site`. Repository secrets `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` and `VERCEL_TOKEN` (a token scoped to that team) | The `docs` job deploys useheel.dev and points the domain at the new deployment. |
| Public image | GitHub, the `heel` container package's settings | GitHub creates container packages as private. Make it public after the first release, so `docker pull` works without signing in. |
