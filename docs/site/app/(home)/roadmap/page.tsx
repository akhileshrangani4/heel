import type { Metadata } from 'next';
import Link from 'next/link';
import { SiteFooter } from '@/components/site-footer';
import { longDate, releases } from '@/lib/changelog';
import { githubUrl } from '@/lib/shared';

export const metadata: Metadata = {
  title: 'Roadmap',
  description:
    'What heel is building next: an agent that sets heel up while you approve every change, then a public launch and fewer setup steps.',
  alternates: { canonical: '/roadmap' },
};

const UPDATED = 'november 20, 2026';

type Status = 'done' | 'now' | 'next' | 'later';

/** Where one item stands. No state means not started yet. */
type ItemState = 'shipped' | 'started';

type Item = [title: string, detail: string, state?: ItemState];

type Phase = {
  status: Status;
  name: string;
  summary: string;
  items: Item[];
  /** What has to be true before the next phase starts. */
  gate: string;
};

const PHASES: Phase[] = [
  {
    status: 'done',
    name: 'trust and clarity',
    summary:
      'approvals anyone can read, a redesigned web app and cli, and a security pass before more people rely on heel.',
    items: [
      [
        'approvals you can read at a glance',
        'one plain sentence per request. an email shows to, cc, subject and body; ids and metadata fold away.',
        'shipped',
      ],
      [
        'the agent says why',
        'a short reason from the agent on every request. it informs you; it never decides.',
        'shipped',
      ],
      [
        'it remembers what you look at',
        'sections you fold away stay folded the next time the same action asks.',
        'shipped',
      ],
      ['which agent, which client', 'every request names the agent and the app it came from.', 'shipped'],
      [
        'a new web app',
        'every page redesigned around one design system, with clear navigation and no jargon.',
        'shipped',
      ],
      [
        'a better cli, and a tui',
        'clearer commands and errors, a live terminal view, and heel start so it all runs in one terminal.',
        'shipped',
      ],
      [
        'security hardening',
        'heel warns when agents could reach its files, and documents how to keep them out.',
        'shipped',
      ],
      ['expiring agent tokens', 'tokens last 90 days, warn before they end and renew with one command.', 'shipped'],
      [
        'sign in with google, no setup',
        'connect gmail and calendar with one click, even when heel runs on another machine.',
        'shipped',
      ],
      [
        'three red-team rounds',
        'ai models tried to read secrets, approve themselves and rewrite rules. every finding is fixed and tested.',
        'shipped',
      ],
      [
        'plainer wording',
        'rules decide every call. the docs name the two places a model is involved.',
        'shipped',
      ],
    ],
    gate: 'someone who has never seen heel approves an email from their phone without asking what anything means.',
  },
  {
    status: 'now',
    name: 'the agent sets heel up',
    summary:
      'your agent does the configuring. nothing it proposes takes effect until you approve it with a passkey.',
    items: [
      [
        'proposals, not edits',
        'agents propose rules, and you’re notified to add them with a passkey. connections and new agents come next.',
        'started',
      ],
      [
        'a reason on every rule',
        '“read: so I can review your repos.” “merge: needs you.” each proposed rule says what it’s for.',
        'started',
      ],
      [
        'changes as a readable diff',
        '“may also email bob@company.com” instead of yaml. the file stays behind the scenes.',
        'started',
      ],
      ['change history', 'which agent proposed each change, who approved it and when.', 'started'],
      [
        'guided setup',
        'pick how you’ll approve. heel starts the tunnel and turns on phone notifications.',
        'started',
      ],
      [
        'remote first',
        'run heel on a server or an always-on mac, reach it from every agent over tailscale, and manage it from your laptop.',
        'started',
      ],
      [
        'agents ask for connections',
        'an agent can request a new account. you finish it, and the agent never sees the secret.',
      ],
      [
        'one setup prompt',
        'tell any agent to put your services behind heel. it proposes the connections and rules, then walks you through swapping out raw keys.',
      ],
      ['everything in the web app', 'anything the cli can do, the web app can do too.'],
    ],
    gate: 'on a fresh server, one prompt to an agent puts github and gmail behind heel, and all you do is tap approve.',
  },
  {
    status: 'next',
    name: 'launch',
    summary: 'show the whole thing working, end to end.',
    items: [
      ['a walkthrough video', 'from install to an agent that sets heel up, with you approving each step.'],
      ['the email demo', 'an agent that reads and drafts your mail, but asks before anything is sent.'],
      ['how heel was built', 'a write-up of the research, the decisions and what we learned.'],
      ['a new home page', 'the real app up front, with an example rules file.'],
    ],
    gate: 'people set heel up on their own, without help.',
  },
  {
    status: 'later',
    name: 'reach',
    summary: 'fewer setup steps, and heel where agents already run.',
    items: [
      ['claude code plugin', 'install it, and every mcp server you add goes through heel.'],
      [
        'hosted tunnel',
        'link your heel at useheel.dev for phone approvals with no tunnel setup. self-hosting stays first class.',
      ],
      ['import from 1password', 'bring your existing api keys into heel in one step.'],
      [
        'your connections on every machine',
        'heel login on any of your machines, and your connections are there, end-to-end encrypted.',
      ],
      [
        'starter rules per service',
        'sensible defaults for each built-in service: reads allowed, sends and merges ask, deletes counted.',
      ],
      ['more mcp servers', 'more third-party servers tested, and the odd ones handled.'],
      ['teams', 'organizations, roles and org-wide rules.'],
    ],
    gate: 'install to your first phone approval in under 10 minutes, without the docs.',
  },
];

const EXPLORING: [string, string][] = [
  ['access that needs a reason', 'some data is read only with a stated reason, logged and shown to the approver.'],
  ['approval from more than one person', 'one task that needs sign-off from two people, each owning different data.'],
  ['results without the raw data', 'an agent that can share a query’s answer, but not the data behind it.'],
  ['plain-text guidance for hints', 'describe in words what usually looks fine. rules still decide.'],
];

const STATUS: Record<Status, { label: string; sticker: string }> = {
  done: {
    label: 'done',
    sticker:
      'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  },
  now: {
    label: 'now',
    sticker:
      'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300',
  },
  next: {
    label: 'next',
    sticker:
      'border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-900 dark:bg-indigo-950 dark:text-indigo-300',
  },
  later: {
    label: 'later',
    sticker:
      'border-neutral-300 bg-white text-neutral-600 dark:border-white/15 dark:bg-white/5 dark:text-neutral-300',
  },
};

const underline =
  'underline decoration-neutral-300 underline-offset-4 hover:decoration-current dark:decoration-neutral-600';

function Sticker({ status, tilt = '' }: { status: Status; tilt?: string }) {
  return (
    <span
      className={`inline-block rounded-md border px-2 py-0.5 font-mono text-[11px] font-medium ${STATUS[status].sticker} ${tilt}`}
    >
      {STATUS[status].label}
    </span>
  );
}

/** One square per item: filled when shipped, half when started, empty when not yet. */
function Progress({ items, large = false }: { items: Item[]; large?: boolean }) {
  const shipped = items.filter(([, , s]) => s === 'shipped').length;
  const started = items.filter(([, , s]) => s === 'started').length;
  const size = large ? 'size-3' : 'size-2.5';
  return (
    <div>
      <div aria-hidden className="flex flex-wrap gap-1">
        {items.map(([title, , state]) => (
          <span
            key={title}
            className={`${size} rounded-[3px] ${
              state === 'shipped'
                ? 'bg-emerald-500'
                : state === 'started'
                  ? 'bg-[linear-gradient(135deg,var(--color-amber-400)_50%,transparent_50%)] ring-1 ring-amber-400 ring-inset'
                  : 'ring-1 ring-black/15 ring-inset dark:ring-white/20'
            }`}
          />
        ))}
      </div>
      <p className="mt-2 font-mono text-[11px] text-neutral-500 tabular-nums">
        {shipped} of {items.length} shipped
        {started > 0 ? ` · ${started} under way` : ''}
      </p>
    </div>
  );
}

const MARK: Record<ItemState | 'planned', { glyph: string; className: string; label: string }> = {
  shipped: { glyph: '✓', className: 'text-emerald-600 dark:text-emerald-400', label: 'shipped' },
  started: { glyph: '◐', className: 'text-amber-600 dark:text-amber-400', label: 'under way' },
  planned: { glyph: '○', className: 'text-neutral-400', label: 'not started' },
};

function Row({ item: [title, detail, state] }: { item: Item }) {
  const mark = MARK[state ?? 'planned'];
  return (
    <li className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-3 border-t border-black/[0.06] py-4 first:border-t-0 dark:border-white/[0.08]">
      <span aria-label={mark.label} className={`font-mono text-sm leading-6 ${mark.className}`}>
        {mark.glyph}
      </span>
      <div>
        <p className="font-medium leading-6">{title}</p>
        <p className="mt-0.5 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
          {detail}
        </p>
      </div>
    </li>
  );
}

/** What's under way first, then what's planned; what shipped folds away below. */
function Items({ items }: { items: Item[] }) {
  const open = [
    ...items.filter(([, , s]) => s === 'started'),
    ...items.filter(([, , s]) => s === undefined),
  ];
  const shipped = items.filter(([, , s]) => s === 'shipped');
  return (
    <div>
      {open.length > 0 ? (
        <ul>
          {open.map((item) => (
            <Row key={item[0]} item={item} />
          ))}
        </ul>
      ) : null}
      {shipped.length > 0 ? (
        <details className="group" open={open.length === 0}>
          <summary
            className={`flex cursor-pointer list-none items-center gap-2 py-4 font-mono text-xs text-neutral-500 hover:text-neutral-900 dark:hover:text-white [&::-webkit-details-marker]:hidden ${
              open.length > 0 ? 'border-t border-black/[0.06] dark:border-white/[0.08]' : ''
            }`}
          >
            <span className="text-emerald-600 dark:text-emerald-400">✓</span>
            {shipped.length} shipped
            <span className="transition-transform group-open:rotate-90">›</span>
          </summary>
          <ul>
            {shipped.map((item) => (
              <Row key={item[0]} item={item} />
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/** The latest release, as `heel update` would put it, linking to the changelog. */
function JustShipped() {
  const [latest] = releases();
  if (latest === undefined) return null;
  const added = latest.groups.find((g) => g.kind === 'new')?.changes ?? [];
  const fixed = latest.groups.find((g) => g.kind === 'fixed')?.changes ?? [];
  return (
    <section className="mx-auto mt-16 max-w-[880px] px-5">
      <div className="overflow-hidden rounded-xl border border-black/10 bg-[#141414] text-[#e8e8e6] shadow-[0_24px_60px_-28px_rgba(0,0,0,0.45)] dark:border-white/10">
        <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-3">
          <span className="size-3 rounded-full bg-[#ff5f57]" />
          <span className="size-3 rounded-full bg-[#febc2e]" />
          <span className="size-3 rounded-full bg-[#28c840]" />
          <span className="ml-3 font-mono text-xs text-white/40">just shipped</span>
        </div>
        <div className="px-5 py-5 font-mono text-[12.5px] leading-[1.9] sm:px-6">
          <p>
            <span className="text-white/35">$ </span>heel update
          </p>
          <p className="text-emerald-400">
            heel is now {latest.version}
            <span className="text-white/35"> · {longDate(latest.date)}</span>
          </p>
          <ul className="mt-1">
            {added.slice(0, 4).map((change) => (
              <li key={change.text} className="flex gap-3">
                <span className="text-emerald-400">+</span>
                <span className="min-w-0 text-white/80">{change.text}</span>
              </li>
            ))}
          </ul>
          {added.length > 4 || fixed.length > 0 ? (
            <p className="text-white/40">
              {added.length > 4 ? `+ ${added.length - 4} more new` : ''}
              {added.length > 4 && fixed.length > 0 ? ', ' : ''}
              {fixed.length > 0 ? `${fixed.length} fixed` : ''}
            </p>
          ) : null}
        </div>
      </div>
      <p className="mt-3 text-sm text-neutral-500">
        <Link href="/changelog" className={underline}>
          full changelog →
        </Link>
      </p>
    </section>
  );
}

export default function RoadmapPage() {
  const current = PHASES.findIndex((p) => p.status === 'now');
  return (
    <main className="relative flex-1 overflow-x-clip bg-[radial-gradient(circle,rgba(0,0,0,0.07)_1px,transparent_1px)] bg-[length:22px_22px] dark:bg-[radial-gradient(circle,rgba(255,255,255,0.06)_1px,transparent_1px)]">
      <section className="mx-auto flex max-w-[1100px] flex-col items-center px-5 pt-16 text-center sm:pt-24">
        <h1 className="rise text-[clamp(3rem,10vw,5.5rem)] leading-none font-semibold tracking-[-0.06em]">
          roadmap
        </h1>
        <p
          className="rise mt-4 max-w-xl text-lg text-neutral-600 dark:text-neutral-300"
          style={{ animationDelay: '60ms' }}
        >
          approvals you can read are done. now: an agent that sets heel up while you approve every
          change.
        </p>
        <p className="rise mt-3 text-xs text-neutral-400" style={{ animationDelay: '120ms' }}>
          updated {UPDATED} · plans change as we learn
        </p>
      </section>

      <nav
        aria-label="phases"
        className="rise mx-auto mt-14 max-w-[1100px] px-5"
        style={{ animationDelay: '180ms' }}
      >
        <ol className="relative grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 lg:gap-0">
          <span
            aria-hidden
            className="pointer-events-none absolute top-[1.15rem] right-[12.5%] left-[12.5%] hidden h-px bg-black/10 lg:block dark:bg-white/15"
          />
          {PHASES.map((phase, i) => (
            <li key={phase.name} className="relative lg:px-2">
              <a
                href={`#phase-${i + 1}`}
                className={`group block h-full rounded-xl border p-4 text-left transition-colors lg:mt-8 ${
                  i === current
                    ? 'border-amber-300 bg-white shadow-[0_12px_30px_-18px_rgba(180,120,0,0.5)] dark:border-amber-800 dark:bg-white/10'
                    : 'border-black/10 bg-white/70 hover:bg-white dark:border-white/10 dark:bg-white/5 dark:hover:bg-white/10'
                }`}
              >
                <span
                  aria-hidden
                  className={`absolute top-3 left-1/2 hidden size-3 -translate-x-1/2 rounded-full border-2 lg:block ${
                    phase.status === 'done'
                      ? 'border-emerald-500 bg-emerald-500'
                      : i === current
                        ? 'border-amber-500 bg-white dark:bg-neutral-900'
                        : 'border-black/20 bg-white dark:border-white/25 dark:bg-neutral-900'
                  }`}
                />
                <span className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[11px] text-neutral-400">phase {i + 1}</span>
                  <Sticker status={phase.status} />
                </span>
                <span className="mt-2 block font-semibold tracking-[-0.02em]">{phase.name}</span>
                <span className="mt-3 block">
                  <Progress items={phase.items} />
                </span>
              </a>
            </li>
          ))}
        </ol>
      </nav>

      <JustShipped />

      {PHASES.map((phase, i) => (
        <section
          key={phase.name}
          id={`phase-${i + 1}`}
          className="mx-auto mt-24 grid max-w-[1100px] scroll-mt-24 grid-cols-[minmax(0,1fr)] items-start gap-8 px-5 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] md:gap-14"
        >
          <div className="md:sticky md:top-24">
            <div className="flex items-center gap-3">
              <Sticker status={phase.status} tilt={i === current ? '-rotate-3' : ''} />
              <span className="font-mono text-xs text-neutral-400">phase {i + 1}</span>
            </div>
            <h2 className="mt-3 text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">
              {phase.name}
            </h2>
            <p className="mt-4 max-w-md leading-relaxed text-neutral-600 dark:text-neutral-300">
              {phase.summary}
            </p>
            <div className="mt-6">
              <Progress items={phase.items} large />
            </div>
            <p className="mt-6 max-w-md rounded-lg bg-black/[0.03] px-4 py-3 text-sm leading-relaxed text-neutral-600 dark:bg-white/5 dark:text-neutral-400">
              <span className="font-mono text-[11px] text-neutral-400">
                {i === PHASES.length - 1 ? 'done when' : phase.status === 'done' ? 'gate · met' : 'gate'}
              </span>
              <br />
              {phase.gate}
            </p>
          </div>
          <Items items={phase.items} />
        </section>
      ))}

      <section className="mx-auto mt-24 grid max-w-[1100px] grid-cols-[minmax(0,1fr)] items-start gap-8 px-5 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] md:gap-14">
        <div>
          <span className="font-mono text-xs text-neutral-400">exploring</span>
          <h2 className="mt-3 text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">
            open questions
          </h2>
          <p className="mt-4 max-w-md leading-relaxed text-neutral-600 dark:text-neutral-300">
            ideas we’re researching. none is promised yet.{' '}
            <a href={`${githubUrl}/issues`} className={underline}>
              tell us what you need
            </a>
            .
          </p>
        </div>
        <ul>
          {EXPLORING.map(([title, detail]) => (
            <li
              key={title}
              className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-3 border-t border-black/[0.06] py-4 first:border-t-0 dark:border-white/[0.08]"
            >
              <span aria-hidden className="font-mono text-sm leading-6 text-indigo-500">
                ?
              </span>
              <div>
                <p className="font-medium leading-6">{title}</p>
                <p className="mt-0.5 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
                  {detail}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <div className="pb-24" />
      <SiteFooter />
    </main>
  );
}
