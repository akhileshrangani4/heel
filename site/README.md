# useheel.dev

heel's docs site: Next.js with [Fumadocs](https://fumadocs.dev). The pages aren't written here. `scripts/sync.mjs` builds them from the repo's `README.md` and `docs/*.md` before every `dev` and `build`, so edit those.

```sh
cd site
npm ci
npm run dev      # http://localhost:3000
npm run build
```

- **Order and titles:** the sidebar order is `PAGES` in `scripts/sync.mjs`. Each page's title is its H1, and its description is its first sentence.
- **Links:** links between docs stay links between pages. Links to other repo files go to GitHub.
- **Not published:** `docs/design/` and `docs/research/` stay in the repo.
- **CI:** the `docs site builds` job builds the site on every PR.

## Deploying

useheel.dev is the Vercel project `useheel` (Root Directory `site`). Production deploys come from [`.github/workflows/docs.yml`](../.github/workflows/docs.yml), never from pushes:

- **On a release:** the release workflow deploys the released commit once npm has it, so the site always documents a version people can install.
- **By hand:** run the `docs` workflow from the Actions tab. It deploys the latest release tag by default, or any ref you give it.

Vercel's GitHub app also builds a preview for every PR. The project's Ignored Build Step skips any production build that doesn't carry `HEEL_RELEASE_DEPLOY=1`, which only `docs.yml` sets, so a push to `main` never changes the live site.

The root `.vercelignore` limits the upload to what the site reads: `site/`, `docs/` (without `design/` and `research/`), `assets/` and `README.md`.
