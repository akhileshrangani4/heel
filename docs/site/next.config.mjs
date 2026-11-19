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
    return [{ source: '/docs/using-heel', destination: '/docs/connect', permanent: true }];
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
