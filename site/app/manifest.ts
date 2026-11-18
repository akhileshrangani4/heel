import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'heel',
    short_name: 'heel',
    description: 'Intent-based access control for AI agents.',
    start_url: '/',
    display: 'browser',
    background_color: '#f5f5f4',
    theme_color: '#f5f5f4',
    icons: [
      { src: '/heel-icon-180.png', sizes: '180x180', type: 'image/png' },
      { src: '/heel-icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/heel-icon.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
  };
}
