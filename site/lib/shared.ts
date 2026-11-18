import { createGetUrl } from 'fumadocs-core/source';

export const appName = 'heel';
export const siteUrl = 'https://useheel.dev';
export const docsRoute = '/docs';
export const docsImageRoute = '/og/docs';

export const gitConfig = {
  user: 'akhileshrangani4',
  repo: 'heel',
  branch: 'main',
};

export const githubUrl = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;
export const npmUrl = 'https://www.npmjs.com/package/useheel';

const getImageUrl = createGetUrl(docsImageRoute);

export function getPageImageUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [...page.slugs, 'image.png'];

  return { segments, url: getImageUrl(segments, page.locale) };
}
