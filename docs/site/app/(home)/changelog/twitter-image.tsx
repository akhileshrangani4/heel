import { ogCard, ogSize } from '@/lib/og';

export const alt = 'heel changelog';
export const size = ogSize;
export const contentType = 'image/png';

export default function Image() {
  return ogCard({
    title: 'The heel changelog',
    description:
      'Every heel release, newest first: what’s new and what’s fixed.',
    label: 'new · fixed',
  });
}
