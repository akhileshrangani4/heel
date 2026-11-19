import type { Metadata } from 'next';
import Link from 'next/link';
import { SiteFooter } from '@/components/site-footer';
import { githubUrl } from '@/lib/shared';

export const metadata: Metadata = {
  title: 'Roadmap',
  description:
    'What heel is building next: approvals you can read at a glance, agents that set heel up while you approve every change, and a redesigned web app and CLI.',
  alternates: { canonical: '/roadmap' },
};

const UPDATED = 'november 19, 2026';

type Status = 'now' | 'next' | 'later' | 'exploring';

/** Where one item stands: shipped, or started. No state means not started yet. */
type ItemState = 'shipped' | 'started';

type Phase = {
  status: Status;
  name: string;
  summary: string;
  items: [string, string, ItemState?][];
  gate?: string;
};

const PHASES: Phase[] = [
  {
    status: 'now',
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
        'a short reason from the agent at the top of every request. it informs you; it never decides.',
        'shipped',
      ],
      [
        'it remembers what you look at',
        'fields you fold away stay folded the next time the same action asks.',
        'shipped',
      ],
      ['which agent, which session', 'every request names the agent, its session and where it runs.', 'shipped'],
      [
        'a new web app',
        'every page redesigned around one design system, with clear navigation and no jargon.',
        'shipped',
      ],
      [
        'a better cli, and a tui',
        'clearer commands, help and errors, plus a terminal ui for setup, activity and approvals. plain output stays for scripts and agents.',
        'shipped',
      ],
      [
        'security hardening',
        'agents can’t read the vault or edit rules, and binding outside localhost warns loudly.',
        'shipped',
      ],
      ['expiring agent tokens', 'agent tokens renew on a schedule and revoke with one command.', 'shipped'],
      [
        'sign in with google, no setup',
        'connect gmail and calendar with one click. heel brings its own google client, and it works when heel runs on another machine too.',
      ],
      [
        'red-team rounds',
        'repeated attempts by ai models to read secrets, approve themselves or rewrite rules. every finding becomes a test.',
        'shipped',
      ],
      [
        'plainer wording',
        'rules decide every call. the docs name the two places a model is involved: the hiding classifier and optional hints.',
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
        'agents propose rules, connections and new agents. each waits as a draft until you approve it, and agents can’t write the rules file.',
        'started',
      ],
      [
        'a reason on every rule',
        '“read: so I can review your repos.” “merge: needs you.” each line says what it’s for.',
        'started',
      ],
      [
        'changes as a readable diff',
        '“may also email bob@company.com” instead of yaml. the file stays behind the scenes.',
        'started',
      ],
      ['change history', 'which agent proposed each change, who approved it and when.', 'started'],
      [
        'agents ask for connections',
        'an agent can request a new account. you finish it, and the agent never sees the secret.',
      ],
      [
        'one setup prompt',
        'tell any agent to put your services behind heel. it proposes the connections and rules, then walks you through swapping out raw keys.',
      ],
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
      ['everything in the web app', 'anything the cli can do, the web app can do too.'],
    ],
    gate: 'on a fresh server, one prompt to an agent puts github and gmail behind heel, and all you do is tap approve.',
  },
  {
    status: 'next',
    name: 'launch',
    summary: 'show the whole thing working, end to end.',
    items: [
      [
        'a walkthrough video',
        'from install to an agent that sets heel up, with you approving each step.',
      ],
      [
        'the email demo',
        'an agent that can read and draft your mail, but asks before anything is sent.',
      ],
      ['how heel was built', 'a write-up of the research, what we tried and what we learned.'],
      ['a new home page', 'the real app up front, with an example rules file.'],
    ],
    gate: 'people set heel up on their own, without help.',
  },
  {
    status: 'later',
    name: 'reach',
    summary: 'fewer setup steps, and heel where agents already run.',
    items: [
      [
        'claude code plugin',
        'install it, and every mcp server you add goes through heel automatically.',
      ],
      [
        'hosted tunnel',
        'link your heel at useheel.dev for phone approvals with no tunnel setup. self-hosting stays first class.',
      ],
      ['import from 1password', 'bring your existing api keys into heel in one step.'],
      [
        'your connections on every machine',
        'run heel login on any of your machines and your connections are there, end-to-end encrypted. or point every machine’s agents at one heel.',
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
  [
    'access that needs a reason',
    'some data should only be read with a stated reason, logged and shown to the approver.',
  ],
  [
    'approval from more than one person',
    'one task that needs sign-off from two people, each owning different data.',
  ],
  [
    'results without the raw data',
    'an agent that can share a query’s answer, but not the data behind it.',
  ],
  ['plain-text guidance for hints', 'describe in words what usually looks fine. rules still decide.'],
];

const SHIPPED = [
  'rules on every call’s actual arguments',
  'passkey approvals, from your phone',
  'hiding what agents read',
  'pause any agent, account or everything',
  'standing approvals and grants',
  'local-only by default',
  'optional decision-model hints',
  'credentials never enter the sandbox',
  'a complete rules reference',
];

const badge: Record<Status, string> = {
  now: 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  next: 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300',
  later:
    'border-neutral-300 bg-white text-neutral-600 dark:border-white/15 dark:bg-white/5 dark:text-neutral-300',
  exploring:
    'border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-900 dark:bg-indigo-950 dark:text-indigo-300',
};

function Badge({ status }: { status: Status }) {
  return (
    <span
      className={`inline-block rounded-md border px-2 py-0.5 font-mono text-xs font-medium ${badge[status]}`}
    >
      {status}
    </span>
  );
}

const itemTag: Record<ItemState, string> = {
  shipped:
    'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  started:
    'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300',
};

function Items({ items }: { items: [string, string, ItemState?][] }) {
  return (
    <dl className="grid gap-x-10 gap-y-6 sm:grid-cols-2">
      {items.map(([term, detail, state]) => (
        <div key={term}>
          <dt className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
            {term}
            {state === undefined ? null : (
              <span
                className={`inline-block rounded-md border px-1.5 py-px font-mono text-[11px] font-medium ${itemTag[state]}`}
              >
                {state}
              </span>
            )}
          </dt>
          <dd className="mt-1 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
            {detail}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export default function RoadmapPage() {
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
          where heel is going: approvals you can read at a glance, and an agent that sets heel up
          while you approve every change.
        </p>
        <p className="rise mt-3 text-xs text-neutral-400" style={{ animationDelay: '120ms' }}>
          updated {UPDATED} · plans change as we learn
        </p>

        <ol
          className="rise mt-12 grid w-full max-w-[880px] grid-cols-2 gap-3 text-left sm:grid-cols-4"
          style={{ animationDelay: '180ms' }}
        >
          {PHASES.map((phase, i) => (
            <li key={phase.name}>
              <a
                href={`#phase-${i + 1}`}
                className="block h-full rounded-xl border border-black/10 bg-white/80 p-4 transition-colors hover:bg-white dark:border-white/10 dark:bg-white/5 dark:hover:bg-white/10"
              >
                <Badge status={phase.status} />
                <span className="mt-3 block font-mono text-xs text-neutral-400">
                  phase {i + 1}
                </span>
                <span className="mt-0.5 block font-medium">{phase.name}</span>
              </a>
            </li>
          ))}
        </ol>
      </section>

      {PHASES.map((phase, i) => (
        <section
          key={phase.name}
          id={`phase-${i + 1}`}
          className="mx-auto mt-24 grid max-w-[1100px] scroll-mt-24 grid-cols-[minmax(0,1fr)] items-start gap-8 px-5 md:grid-cols-[minmax(0,0.75fr)_minmax(0,1.25fr)] md:gap-14"
        >
          <div className="md:sticky md:top-24">
            <div className="flex items-center gap-3">
              <Badge status={phase.status} />
              <span className="font-mono text-xs text-neutral-400">phase {i + 1}</span>
            </div>
            <h2 className="mt-3 text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">
              {phase.name}
            </h2>
            <p className="mt-4 max-w-md leading-relaxed text-neutral-600 dark:text-neutral-300">
              {phase.summary}
            </p>
            {phase.gate ? (
              <p className="mt-5 max-w-md border-l-2 border-black/10 pl-4 text-sm leading-relaxed text-neutral-500 dark:border-white/15 dark:text-neutral-400">
                <span className="font-medium text-neutral-900 dark:text-white">
                  {i === PHASES.length - 1 ? 'done when: ' : 'gate: '}
                </span>
                {phase.gate}
              </p>
            ) : null}
          </div>
          <Items items={phase.items} />
        </section>
      ))}

      <section className="mx-auto mt-24 grid max-w-[1100px] grid-cols-[minmax(0,1fr)] items-start gap-8 px-5 md:grid-cols-[minmax(0,0.75fr)_minmax(0,1.25fr)] md:gap-14">
        <div>
          <Badge status="exploring" />
          <h2 className="mt-3 text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">
            open questions
          </h2>
          <p className="mt-4 max-w-md leading-relaxed text-neutral-600 dark:text-neutral-300">
            ideas we’re researching. none is promised yet.
          </p>
        </div>
        <Items items={EXPLORING} />
      </section>

      <section className="mx-auto mt-24 max-w-[1100px] px-5">
        <div className="rounded-xl border border-black/10 bg-white/80 p-6 sm:p-8 dark:border-white/10 dark:bg-white/5">
          <h2 className="text-xl font-semibold tracking-[-0.03em]">already in heel</h2>
          <ul className="mt-4 flex flex-wrap gap-2">
            {SHIPPED.map((item) => (
              <li
                key={item}
                className="rounded-full border border-black/10 px-3 py-1 text-sm text-neutral-600 dark:border-white/15 dark:text-neutral-300"
              >
                {item}
              </li>
            ))}
          </ul>
          <p className="mt-5 text-sm text-neutral-500">
            <Link
              href="/docs"
              className="underline decoration-neutral-300 underline-offset-4 hover:decoration-current dark:decoration-neutral-600"
            >
              get started
            </Link>{' '}
            or{' '}
            <a
              href={`${githubUrl}/issues`}
              className="underline decoration-neutral-300 underline-offset-4 hover:decoration-current dark:decoration-neutral-600"
            >
              tell us what you need
            </a>
            .
          </p>
        </div>
      </section>

      <div className="pb-24" />
      <SiteFooter />
    </main>
  );
}
