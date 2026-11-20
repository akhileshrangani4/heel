import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ImageResponse } from 'next/og';

/** The OG card: the home page's look at 1200×630, for the site and every docs page. */

export const ogSize = { width: 1200, height: 630 };

const DOG = String.raw`   / \__
  (    @\___
  /         O
 /   (_____/
/_____/   U`;

/**
 * The card's fonts, as TTF files kept in `lib/fonts` (next/og can't use woff2).
 * Kept in the repo rather than fetched from Google Fonts at build time, so a
 * network hiccup can't fail the build.
 */
function font(file: string): Promise<Buffer> {
  return readFile(join(process.cwd(), 'lib', 'fonts', file));
}

export async function ogCard({
  title,
  description,
  label,
}: {
  title: string;
  description: string;
  label: string;
}): Promise<ImageResponse> {
  const [regular, semibold, mono] = await Promise.all([
    font('inter-400.ttf'),
    font('inter-600.ttf'),
    font('geist-mono-400.ttf'),
  ]);
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: '64px 72px',
        background: '#f5f5f4',
        backgroundImage: 'radial-gradient(circle, rgba(0,0,0,0.08) 1.5px, transparent 1.5px)',
        backgroundSize: '26px 26px',
        color: '#171717',
        fontFamily: 'Inter',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 28 }}>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              fontFamily: 'Geist Mono',
              fontSize: 17,
              lineHeight: 1.25,
              color: '#737373',
              whiteSpace: 'pre',
            }}
          >
            {DOG.split('\n').map((line) => (
              <span key={line}>{line}</span>
            ))}
          </div>
          <span style={{ fontSize: 76, fontWeight: 600, letterSpacing: '-0.06em' }}>heel</span>
        </div>
        <span
          style={{
            display: 'flex',
            fontFamily: 'Geist Mono',
            fontSize: 22,
            color: '#b45309',
            background: '#fef3c7',
            border: '1.5px solid #fcd34d',
            borderRadius: 10,
            padding: '6px 16px',
            transform: 'rotate(4deg)',
          }}
        >
          {label}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <span
          style={{
            fontSize: title.length > 34 ? 58 : 68,
            fontWeight: 600,
            letterSpacing: '-0.045em',
            lineHeight: 1.05,
            maxWidth: 1000,
          }}
        >
          {title}
        </span>
        {description ? (
          <span style={{ fontSize: 28, color: '#525252', lineHeight: 1.4, maxWidth: 980 }}>
            {description.length > 150 ? `${description.slice(0, 147).trimEnd()}…` : description}
          </span>
        ) : null}
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontSize: 24,
          color: '#737373',
        }}
      >
        <span
          style={{
            display: 'flex',
            fontFamily: 'Geist Mono',
            background: '#171717',
            color: '#fafafa',
            borderRadius: 999,
            padding: '12px 26px',
            fontSize: 22,
          }}
        >
          $ npm install -g useheel
        </span>
        <span>useheel.dev</span>
      </div>
    </div>,
    {
      ...ogSize,
      fonts: [
        { name: 'Inter', data: regular, weight: 400 },
        { name: 'Inter', data: semibold, weight: 600 },
        { name: 'Geist Mono', data: mono, weight: 400 },
      ],
    },
  );
}
