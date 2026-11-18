# Releasing heel

Releases are made by merging a release PR. Nothing is published until you merge one.

1. **The release PR.** After CI passes on `main`, [release-please](https://github.com/googleapis/release-please) opens a PR titled `chore(main): release <version>`, or updates the one that's open. It bumps `version` in `package.json` and adds the release to `CHANGELOG.md`, using the titles of the PRs merged since the last release:
   - `feat:` bumps the minor version (0.1.0 to 0.2.0).
   - `fix:` bumps the patch version (0.1.0 to 0.1.1).
   - A breaking change (`feat!:`, or a `BREAKING CHANGE:` footer) bumps the major version from 1.0.0 onwards, and the minor version before that.
   - Other types (`docs:`, `ci:`, `chore:`, `test:`) don't release anything on their own.
2. **Merging it is the release.** release-please tags `v<version>` and creates the GitHub release. Then [`.github/workflows/release.yml`](../.github/workflows/release.yml) publishes it:
   - A build job with no write access installs the dependencies and runs `pnpm package:smoke`. The smoke test packs heel, installs the tarball with npm into an empty project, and checks that it starts, answers on both planes and accepts admin commands. The job then packs the tarball and builds the image.
   - Two jobs that install nothing publish what the build job made: [`useheel`](https://www.npmjs.com/package/useheel) on npm, with provenance, and `ghcr.io/akhileshrangani4/heel:<version>`.
   - The GitHub release gets install lines.

Each publish checks whether it's already done, so a failed run can be re-run. A pre-release version (`1.2.0-rc.1`) goes to npm's `next` tag. `latest`, on npm and on ghcr.io, only ever moves to a higher version.

The first release is 0.1.0. The release-please manifest starts at 0.0.0, and the `feat:` commits on the v0.1 branch bump that to 0.1.0. Merge [#50](https://github.com/akhileshrangani4/heel/pull/50) with **Create a merge commit**, not squash, so release-please can see those commits. A squash commit titled "Release: heel v0.1" isn't a conventional commit, so no release PR would open.

## The npm package

The package is called `useheel`, and installing it gives you the `heel` command.

- **Why it's compiled:** Node won't strip types inside `node_modules`, so the package ships `src` compiled to `dist`. `pnpm build` does this, and `prepack` runs it.
- **Same layout:** `dist` keeps `src`'s layout, so paths relative to a module stay the same. The data files `src` reads at runtime, like the looks_like weights and the migrations, are copied beside the compiled modules.
- **Which code runs:** `bin/heel.js` runs `src` when it's there (a checkout, the OCI image) and `dist` otherwise.
- **Checked on every PR:** the `npm package installs and serves` CI job runs the same smoke test.

Code mode mounts heel's dependencies read-only into its sandbox. With `npm install -g` they're inside heel's own directory. With a local or npx install, npm or pnpm keeps them in the project's `node_modules`, so code mode mounts that whole directory, read-only.

## One-time setup

The owner of the repository and the npm package does these once:

1. **`RELEASE_TOKEN`.** Create a fine-grained GitHub token for this repository with read and write access to **Contents** and **Pull requests**. Add it as the repository secret `RELEASE_TOKEN`.
   - With it, release PRs are opened from your account, and CI runs on them.
   - Without it, release-please falls back to the workflow's own token. Release PRs are then opened by `github-actions[bot]`, and GitHub doesn't run CI on them.
2. **npm trusted publishing.** On npmjs.com, add a trusted publisher to the `useheel` package: GitHub Actions, repository `akhileshrangani4/heel`, workflow `release.yml`, no environment. npm then accepts publishes from that workflow without a stored token.
   - If npm won't let you add one before the package exists, make the first release with a token instead. Add a granular npm token that can publish as the repository secret `NPM_TOKEN`.
   - After the first release, add the trusted publisher and delete `NPM_TOKEN`. npm prefers the OIDC token whenever trusted publishing is set up, but a leftover token would still be a long-lived credential.
3. **The ghcr.io package's visibility.** GitHub creates a new container package as private. After the first release, make the `heel` package public in its settings, so `docker pull` works without signing in.
