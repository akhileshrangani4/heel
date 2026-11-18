# Releasing heel

Releases are automatic. When CI passes on `main` and `package.json` names a version that has no `v<version>` tag yet, [`.github/workflows/release.yml`](../.github/workflows/release.yml) releases it:

1. **npm:** `pnpm package:smoke` packs heel, installs the tarball with npm into an empty project, and checks that it starts and answers on both planes. Then `npm publish` publishes [`@akhileshrangani4/heel`](https://www.npmjs.com/package/@akhileshrangani4/heel) with provenance.
2. **ghcr.io:** the image is built from the same commit and pushed as `ghcr.io/akhileshrangani4/heel:<version>`, and as `latest`.
3. **GitHub:** the commit is tagged `v<version>`, and a GitHub release is created with install lines and generated notes.

Each step checks whether it's already done, so if a step fails you can re-run the workflow and it continues from that step.

## Making a release

Bump `version` in `package.json` in a PR and merge it. Merging to `main` is the release.

- `1.2.0` publishes to npm's `latest` and tags the image `latest`.
- A version with a pre-release part (`1.2.0-rc.1`) publishes to npm's `next`, doesn't move `latest`, and is marked as a pre-release on GitHub.
- A merge that doesn't change the version releases nothing.

## The npm package

Node won't strip types inside `node_modules`, so the package ships `src` compiled to `dist` (`pnpm build`, run by `prepack`). `dist` keeps `src`'s layout, so paths relative to a module stay the same. The data files `src` reads at runtime, like the looks_like weights and the migrations, are copied beside the compiled modules. `bin/heel.js` runs `src` when it's there (a checkout, the OCI image) and `dist` otherwise. The `npm package installs and serves` CI job runs the same smoke test on every PR.

## One-time setup

These steps are done once, by the owner of the npm scope and the repository:

1. **npm trusted publishing.** On npmjs.com, open the package's settings and add a trusted publisher:
   - GitHub Actions, repository `akhileshrangani4/heel`;
   - workflow `release.yml`, no environment.

   npm then accepts publishes from that workflow without a stored token. If npm requires the package to exist before you can add a publisher, make the first release with a token instead: add a granular npm access token that can publish, as the repository secret `NPM_TOKEN`. After the first release, add the trusted publisher and delete the secret. The workflow passes the secret only as a fallback, and npm prefers the OIDC token whenever trusted publishing is set up.
2. **The ghcr.io package's visibility.** GitHub creates a new container package as private. After the first release, open the package's settings and make it public, so `docker pull` works without signing in.
