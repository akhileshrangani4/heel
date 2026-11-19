import { ogCard, ogSize } from '@/lib/og';

export const alt = 'heel roadmap';
export const size = ogSize;
export const contentType = 'image/png';

export default function Image() {
  return ogCard({
    title: 'The heel roadmap',
    description:
      'Approvals you can read at a glance, agents that set heel up while you approve every change, and a redesigned web app and CLI.',
    label: 'now · next · later',
  });
}
