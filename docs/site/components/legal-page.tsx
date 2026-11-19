import type { ReactNode } from 'react';
import { SiteFooter } from '@/components/site-footer';

/** A plain, readable page for the privacy policy and terms. */
export function LegalPage({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: ReactNode;
}) {
  return (
    <>
      <main className="flex-1">
        <article className="mx-auto max-w-[720px] px-5 pt-16 pb-20 sm:pt-24 [&_a]:underline [&_a]:underline-offset-4 [&_h2]:mt-10 [&_h2]:mb-3 [&_h2]:text-xl [&_h2]:font-semibold [&_li]:mt-2 [&_p]:mt-4 [&_p]:leading-relaxed [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:leading-relaxed">
          <h1 className="text-4xl font-semibold tracking-tight">{title}</h1>
          <p className="text-sm text-neutral-500">Last updated {updated}</p>
          {children}
        </article>
      </main>
      <SiteFooter />
    </>
  );
}
