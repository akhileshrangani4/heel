import type { Metadata } from 'next';
import Link from 'next/link';
import { SiteFooter } from '@/components/site-footer';
import { type Change, type ChangeKind, longDate, type Release, releases } from '@/lib/changelog';
import { githubUrl } from '@/lib/shared';

export const metadata: Metadata = {
  title: 'Changelog',
  description: 'Every heel release, newest first: what’s new and what’s fixed.',
  alternates: { canonical: '/changelog' },
};

/** A release this long shows this many of each group, and folds the rest. */
const SHOWN = 8;

const KIND: Record<Exclude<ChangeKind, 'other'>, { label: string; dot: string }> = {
  new: { label: 'new', dot: 'bg-emerald-500' },
  fixed: { label: 'fixed', dot: 'bg-amber-500' },
  docs: { label: 'docs', dot: 'bg-sky-500' },
};

const underline =
  'underline decoration-neutral-300 underline-offset-4 hover:decoration-current dark:decoration-neutral-600';

/** `0.2.1` as an anchor id: `v0-2-1`. */
const anchor = (version: string) => `v${version.replaceAll('.', '-')}`;

function ChangeRow({ change }: { change: Change }) {
  return (
    <li className="flex items-baseline gap-4 border-t border-black/[0.06] py-3 first:border-t-0 dark:border-white/[0.08]">
      <span className="min-w-0 flex-1 leading-relaxed text-neutral-800 dark:text-neutral-200">
        {change.scope ? (
          <span className="mr-2 rounded border border-black/10 px-1.5 py-px align-[1px] font-mono text-[11px] text-neutral-500 dark:border-white/15 dark:text-neutral-400">
            {change.scope}
          </span>
        ) : null}
        {change.text}
      </span>
      {change.pr ? (
        <a
          href={change.pr.url}
          className="shrink-0 font-mono text-xs text-neutral-400 tabular-nums hover:text-neutral-900 dark:hover:text-white"
        >
          #{change.pr.number}
        </a>
      ) : null}
    </li>
  );
}

function Group({ kind, changes }: { kind: Exclude<ChangeKind, 'other'>; changes: Change[] }) {
  const { label, dot } = KIND[kind];
  const shown = changes.slice(0, SHOWN);
  const rest = changes.slice(SHOWN);
  return (
    <div>
      <h3 className="flex items-center gap-2 font-mono text-xs text-neutral-500">
        <span aria-hidden className={`size-1.5 rounded-full ${dot}`} />
        {label}
        <span className="text-neutral-400">{changes.length}</span>
      </h3>
      <ul className="mt-2">
        {shown.map((change) => (
          <ChangeRow key={`${change.pr?.number ?? ''}${change.text}`} change={change} />
        ))}
      </ul>
      {rest.length > 0 ? (
        <details className="group">
          <summary className="cursor-pointer list-none border-t border-black/[0.06] py-3 text-sm text-neutral-500 hover:text-neutral-900 dark:border-white/[0.08] dark:hover:text-white [&::-webkit-details-marker]:hidden">
            <span className="group-open:hidden">show {rest.length} more</span>
            <span className="hidden group-open:inline">show fewer</span>
          </summary>
          <ul>
            {rest.map((change) => (
              <ChangeRow key={`${change.pr?.number ?? ''}${change.text}`} change={change} />
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function ReleaseEntry({ release, latest }: { release: Release; latest: boolean }) {
  return (
    <article
      id={anchor(release.version)}
      className="grid scroll-mt-24 grid-cols-[minmax(0,1fr)] gap-6 border-t border-black/10 pt-10 md:grid-cols-[200px_minmax(0,1fr)] md:gap-14 dark:border-white/10"
    >
      <header className="md:sticky md:top-24 md:self-start">
        <a href={`#${anchor(release.version)}`} className="group inline-flex items-center gap-3">
          <h2 className="text-3xl font-semibold tracking-[-0.04em] tabular-nums">
            {release.version}
          </h2>
          {latest ? (
            <span className="-rotate-3 rounded-md border border-emerald-300 bg-emerald-50 px-2 py-0.5 font-mono text-[11px] font-medium text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
              latest
            </span>
          ) : null}
        </a>
        <p className="mt-1.5 text-sm text-neutral-500">
          <time dateTime={release.date}>{longDate(release.date)}</time>
        </p>
        {release.compareUrl ? (
          <a href={release.compareUrl} className={`mt-3 inline-block text-xs text-neutral-400 ${underline}`}>
            every commit →
          </a>
        ) : null}
      </header>
      <div className="flex min-w-0 flex-col gap-8">
        {release.groups.length === 0 ? (
          <p className="text-neutral-500">nothing you’d notice: a release to set up publishing.</p>
        ) : (
          release.groups.map((group) =>
            group.kind === 'other' ? null : (
              <Group key={group.kind} kind={group.kind} changes={group.changes} />
            ),
          )
        )}
      </div>
    </article>
  );
}

export default function ChangelogPage() {
  const all = releases();
  return (
    <main className="relative flex-1 overflow-x-clip bg-[radial-gradient(circle,rgba(0,0,0,0.07)_1px,transparent_1px)] bg-[length:22px_22px] dark:bg-[radial-gradient(circle,rgba(255,255,255,0.06)_1px,transparent_1px)]">
      <section className="mx-auto max-w-[1100px] px-5 pt-16 sm:pt-24">
        <h1 className="rise text-[clamp(3rem,10vw,5.5rem)] leading-none font-semibold tracking-[-0.06em]">
          changelog
        </h1>
        <p
          className="rise mt-4 max-w-xl text-lg text-neutral-600 dark:text-neutral-300"
          style={{ animationDelay: '60ms' }}
        >
          every release of heel, newest first. already running it?{' '}
          <code className="whitespace-nowrap rounded bg-black/[0.05] px-1.5 py-0.5 font-mono text-[0.9em] dark:bg-white/10">
            heel update
          </code>{' '}
          brings you to the latest.
        </p>
        <p
          className="rise mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm text-neutral-500"
          style={{ animationDelay: '120ms' }}
        >
          <Link href="/roadmap" className={underline}>
            what’s next →
          </Link>
          <a href={`${githubUrl}/releases`} className={underline}>
            releases on github →
          </a>
        </p>
      </section>

      <div
        className="rise mx-auto mt-14 flex max-w-[1100px] flex-col gap-16 px-5"
        style={{ animationDelay: '180ms' }}
      >
        {all.length === 0 ? (
          <p className="text-neutral-500">no releases yet.</p>
        ) : (
          all.map((release, i) => (
            <ReleaseEntry key={release.version} release={release} latest={i === 0} />
          ))
        )}
      </div>

      <div className="pb-24" />
      <SiteFooter />
    </main>
  );
}
