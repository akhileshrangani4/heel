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

Vercel, as its own project:

1. **Import the repository** and set **Root Directory** to `site`. Vercel detects Next.js; the default build settings work.
2. **Keep files outside the root directory included** (the default). The build reads `../README.md`, `../docs` and `../assets`.
3. **Add the domain** `useheel.dev` to the project.
