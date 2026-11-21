import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/shared';
import { source } from '@/lib/source';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: siteUrl, changeFrequency: 'weekly', priority: 1 },
    { url: `${siteUrl}/roadmap`, changeFrequency: 'weekly', priority: 0.8 },
    { url: `${siteUrl}/changelog`, changeFrequency: 'weekly', priority: 0.7 },
    // For agents: what heel is, and the prompt that sets it up.
    { url: `${siteUrl}/llms.txt`, changeFrequency: 'weekly', priority: 0.8 },
    { url: `${siteUrl}/setup.md`, changeFrequency: 'weekly', priority: 0.8 },
    ...source.getPages().map((page) => ({
      url: `${siteUrl}${page.url}`,
      changeFrequency: 'weekly' as const,
      priority: page.url === '/docs' ? 0.9 : 0.7,
    })),
  ];
}
