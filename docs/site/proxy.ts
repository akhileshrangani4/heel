import { NextRequest, NextResponse } from 'next/server';
import { isMarkdownPreferred, rewritePath } from 'fumadocs-core/negotiation';
import { docsRoute } from '@/lib/shared';

const { rewrite: rewriteDocs } = rewritePath(
  `${docsRoute}{/*path}`,
  `/llms.mdx${docsRoute}{/*path}.md`,
);

/** Pages outside the docs that have a markdown twin for agents. */
const MARKDOWN_TWINS: Record<string, string> = { '/': '/llms.txt', '/setup': '/setup.md' };

export default function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const twin = isMarkdownPreferred(request) ? MARKDOWN_TWINS[pathname] : undefined;
  if (twin !== undefined) {
    return NextResponse.rewrite(new URL(twin, request.nextUrl), { headers: { Vary: 'Accept' } });
  }
  // A person who types useheel.dev/setup gets the page about it.
  if (pathname === '/setup') {
    return NextResponse.redirect(new URL('/docs/quickstart', request.nextUrl), {
      headers: { Vary: 'Accept' },
    });
  }
  // files like `/docs/page.md` are served by the rewrites of the Next.js config
  const result =
    isMarkdownPreferred(request) && !/\.(md|txt)$/.test(pathname) && rewriteDocs(pathname);

  if (result) {
    return NextResponse.rewrite(new URL(result, request.nextUrl), {
      // this URL has two representations, selected by `Accept`
      headers: { Vary: 'Accept' },
    });
  }

  return NextResponse.next();
}
