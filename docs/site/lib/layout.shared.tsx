import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { githubUrl, npmUrl } from './shared';

function Wordmark() {
  return (
    <span className="flex items-center gap-2">
      {/* biome-ignore lint/performance/noImgElement: a static SVG logo */}
      <img src="/heel-icon.svg" alt="" width={24} height={24} className="rounded-md" />
      <span className="text-lg font-semibold leading-none tracking-tight">heel</span>
    </span>
  );
}

export function baseOptions(): BaseLayoutProps {
  return {
    nav: { title: <Wordmark /> },
    githubUrl,
    links: [
      { text: 'docs', url: '/docs', active: 'nested-url' },
      { text: 'roadmap', url: '/roadmap' },
      { text: 'changelog', url: '/changelog' },
      { text: 'npm', url: npmUrl, external: true },
    ],
  };
}
