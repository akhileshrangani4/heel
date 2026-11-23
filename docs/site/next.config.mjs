import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // The repo root has heel's own lockfile; this site is its own package.
  turbopack: { root: dirname(fileURLToPath(import.meta.url)) },
  // Pages that moved keep their old links working.
  async redirects() {
    const moved = [
      ['/docs/using-heel', '/docs/connect'],
      // Nov 2026 consolidation: 21 pages became 12.
      ['/docs/setup', '/docs/quickstart'],
      ['/docs/definitions', '/docs/security'],
      ['/docs/heel-run', '/docs/connect'],
      ['/docs/google-sign-in', '/docs/connect'],
      ['/docs/hints', '/docs/approvals'],
      ['/docs/how-it-works', '/docs'],
      ['/docs/sandbox', '/docs/security'],
      ['/docs/comparison', '/docs/why'],
      ['/docs/incidents', '/docs/why'],
    ];
    const pages = moved.map(([source, destination]) => ({ source, destination, permanent: true }));
    // An agent asking for an old page as markdown gets the new page's markdown.
    const markdown = moved.map(([source, destination]) => ({
      source: `${source}.md`,
      destination: destination === '/docs' ? '/llms.txt' : `${destination}.md`,
      permanent: true,
    }));
    return [...pages, ...markdown];
  },
  async rewrites() {
    return [
      {
        source: '/docs/:path*.md',
        destination: '/llms.mdx/docs/:path*.md',
      },
      {
        source: '/docs/:path*.txt',
        destination: '/llms.mdx/docs/:path*.txt',
      },
    ];
  },
};

export default withMDX(config);
