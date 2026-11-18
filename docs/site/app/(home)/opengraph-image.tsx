import { ogCard, ogSize } from '@/lib/og';

export const alt = 'heel: access control for your AI agents';
export const size = ogSize;
export const contentType = 'image/png';

export default function Image() {
  return ogCard({
    title: 'Your agent has the tools. heel decides what it does with them.',
    description:
      'Rules on every call’s actual arguments, approvals the agent can’t answer, and one switch to stop it. Open source and self-hosted.',
    label: 'allow · ask · deny',
  });
}
