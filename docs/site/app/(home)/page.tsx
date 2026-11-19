import Link from 'next/link';
import { CopyInstall } from '@/components/copy-install';
import { SiteFooter } from '@/components/site-footer';

/** A dog sitting at heel. */
const DOG = String.raw`   / \__
  (    @\___
  /         O
 /   (_____/
/_____/   U`;

type Tone = 'allow' | 'deny' | 'ask' | 'paused' | 'ok';

/** One agent's afternoon in heel's activity: [agent, call, [verdict, tone], note]. */
const ACTIVITY: [string, string, [string, Tone], string][] = [
  ['inbox-bot', 'gmail-work  search "in:inbox"', ['allow', 'allow'], '2 hidden from the result'],
  [
    'inbox-bot',
    'gmail-personal  send → dana@clientco.com',
    ['deny', 'deny'],
    'personal never emails clients',
  ],
  ['inbox-bot', 'gmail-work  reply_all → sam@customer.com', ['ask', 'ask'], 'sent to your phone'],
  ['', 'approved with a passkey by avi', ['sent', 'ok'], 'ran once'],
  ['inbox-bot', 'gmail-work  trash 340 messages', ['ask', 'ask'], 'over 20 this run'],
  ['', 'paused from the phone by avi', ['paused', 'paused'], 'nothing ran'],
];

const RULES = `rules:
  - match: { kind: read }
    then: allow

  # the personal account never emails clients
  - match:
      action: email.send
      account: gmail-personal
      recipients: { any_domain_in: [clientco.com] }
    then: deny

  # coworkers already in the thread
  - match:
      action: email.send
      recipients:
        all_in_thread: true
        all_domain_in: [company.com]
    then: allow

  - match: { action: email.send }
    then: ask

  # count messages, not calls
  - match:
      action: email.remove
      items: { over: 20, per: run }
    then: ask
  - match:
      action: email.remove
      items: { over: 100, per: hour }
    then: ask`;

const POINTS: [string, string][] = [
  [
    'rules on the arguments',
    'who an email goes to, which account it comes from, which repo, whether ci passed, how many messages this run deleted. one yaml file for mcp, http and cli. nothing matched means deny.',
  ],
  [
    'approvals it can’t answer',
    'an ask waits for its owner, who sees the full call and approves with a passkey, outside the agent’s session.',
  ],
  [
    'hiding what it reads',
    'mail from people you name, password resets and login codes drop out before the agent sees them.',
  ],
  [
    'one switch to stop it',
    'pause an agent, an account or everything from your phone. even an approved call stops.',
  ],
  [
    'no model decides a call',
    'whoever shapes a call could shape a model judging it. rules, grants and people decide.',
  ],
  [
    'yours to run',
    'open source, self-hosted, one process. heel holds the credentials; agents only get a heel token.',
  ],
];

const tone: Record<Tone, string> = {
  allow: 'text-emerald-400',
  ok: 'text-emerald-400',
  deny: 'text-red-400',
  ask: 'text-amber-300',
  paused: 'text-indigo-300',
};

const pill =
  'rounded-full border border-black/10 bg-white px-5 py-2.5 text-sm font-medium shadow-[0_1px_2px_rgba(0,0,0,0.06)] transition-colors hover:bg-neutral-50 dark:border-white/15 dark:bg-white/5 dark:hover:bg-white/10';

function Window({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-black/10 bg-[#141414] text-[#e8e8e6] shadow-[0_24px_60px_-28px_rgba(0,0,0,0.45)] dark:border-white/10">
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-3">
        <span className="size-3 rounded-full bg-[#ff5f57]" />
        <span className="size-3 rounded-full bg-[#febc2e]" />
        <span className="size-3 rounded-full bg-[#28c840]" />
        <span className="ml-3 font-mono text-xs text-white/40">{title}</span>
      </div>
      {children}
    </div>
  );
}

function Sticker({ label, className }: { label: string; className: string }) {
  return (
    <span
      aria-hidden
      className={`pointer-events-none absolute hidden rounded-md border px-2.5 py-1 font-mono text-xs font-medium shadow-sm lg:block ${className}`}
    >
      {label}
    </span>
  );
}

export default function HomePage() {
  return (
    <main className="relative flex-1 overflow-x-clip bg-[radial-gradient(circle,rgba(0,0,0,0.07)_1px,transparent_1px)] bg-[length:22px_22px] dark:bg-[radial-gradient(circle,rgba(255,255,255,0.06)_1px,transparent_1px)]">
      <section className="relative mx-auto flex max-w-[1100px] flex-col items-center px-5 pt-16 text-center sm:pt-24">
        <Sticker
          label="allow"
          className="top-28 left-[9%] -rotate-6 border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
        />
        <Sticker
          label="deny"
          className="top-44 right-[8%] rotate-[8deg] border-red-300 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
        />
        <Sticker
          label="ask"
          className="top-[22rem] left-[14%] rotate-[4deg] border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300"
        />

        <pre
          aria-label="a dog sitting at heel"
          className="rise text-left font-mono text-[11px] leading-[1.25] text-neutral-500 sm:text-xs"
        >
          {DOG}
        </pre>
        <h1
          className="rise mt-5 text-[clamp(4rem,13vw,7.5rem)] leading-none font-semibold tracking-[-0.06em]"
          style={{ animationDelay: '60ms' }}
        >
          heel
        </h1>
        <p
          className="rise mt-3 text-lg text-neutral-600 sm:text-xl dark:text-neutral-300"
          style={{ animationDelay: '120ms' }}
        >
          access control for your ai agents
        </p>
        <div
          className="rise mt-8 flex flex-wrap items-center justify-center gap-3"
          style={{ animationDelay: '180ms' }}
        >
          <CopyInstall command="npm install -g useheel" />
          <Link href="/docs" className={pill}>
            read the docs
          </Link>
        </div>
        <p className="rise mt-3 text-xs text-neutral-400" style={{ animationDelay: '220ms' }}>
          open source · self-hosted · node 26.13 or later
        </p>

        <figure className="rise mt-14 w-full max-w-[880px]" style={{ animationDelay: '280ms' }}>
          <Window title="heel · activity">
            <div className="overflow-x-auto px-5 py-5 text-left sm:px-6">
              <table className="w-full min-w-[640px] whitespace-nowrap font-mono text-[12.5px] leading-[1.9]">
                <tbody>
                  {ACTIVITY.map(([agent, call, [verdict, t], note], i) => (
                    <tr
                      // biome-ignore lint/suspicious/noArrayIndexKey: static rows
                      key={i}
                      className="rise"
                      style={{ animationDelay: `${520 + i * 260}ms` }}
                    >
                      <td className="pr-4 text-white/35">{agent}</td>
                      <td className={`pr-4 ${agent ? '' : 'text-white/55'}`}>
                        {agent ? '' : '↳ '}
                        {call}
                      </td>
                      <td className={`pr-4 font-medium ${tone[t]}`}>{verdict}</td>
                      <td className="text-white/40">{note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Window>
          <figcaption className="mt-3 font-mono text-xs text-neutral-400">activity.log</figcaption>
        </figure>
      </section>

      <section className="mx-auto mt-28 grid max-w-[1100px] grid-cols-[minmax(0,1fr)] items-start gap-10 px-5 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] md:gap-14">
        <div className="md:sticky md:top-24">
          <h2 className="text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">
            say what the agent is for
          </h2>
          <p className="mt-4 max-w-md leading-relaxed text-neutral-600 dark:text-neutral-300">
            rules are a file you can read, review and test. the first match decides, and a call no
            rule matches is denied. these are the rules behind the activity above.
          </p>
          <div className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-sm font-medium">
            <Link
              href="/docs/rules"
              className="underline decoration-neutral-300 underline-offset-4 hover:decoration-current dark:decoration-neutral-600"
            >
              how rules work →
            </Link>
            <Link
              href="/docs/rules-reference"
              className="underline decoration-neutral-300 underline-offset-4 hover:decoration-current dark:decoration-neutral-600"
            >
              rules reference and recipes →
            </Link>
            <Link
              href="/docs/using-heel"
              className="underline decoration-neutral-300 underline-offset-4 hover:decoration-current dark:decoration-neutral-600"
            >
              what using heel is like →
            </Link>
          </div>
        </div>
        <figure className="min-w-0">
          <Window title="rules/owner.yaml">
            <pre className="overflow-x-auto px-5 py-5 font-mono text-[12.5px] leading-[1.7] sm:px-6">
              {RULES.split('\n').map((line, i) => {
                const comment = line.trim().startsWith('#');
                const verdict = /then: (allow|deny|ask)/.exec(line);
                return (
                  <span
                    // biome-ignore lint/suspicious/noArrayIndexKey: static lines
                    key={i}
                    className={`block ${comment ? 'text-white/35' : ''}`}
                  >
                    {verdict ? (
                      <>
                        {line.slice(0, verdict.index + 6)}
                        <span className={tone[verdict[1] as Tone]}>{verdict[1]}</span>
                      </>
                    ) : (
                      line || ' '
                    )}
                  </span>
                );
              })}
            </pre>
          </Window>
        </figure>
      </section>

      <section className="mx-auto mt-28 max-w-[1100px] px-5">
        <dl className="grid gap-x-12 gap-y-9 sm:grid-cols-2 lg:grid-cols-3">
          {POINTS.map(([term, detail]) => (
            <div key={term}>
              <dt className="font-medium">{term}</dt>
              <dd className="mt-1.5 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
                {detail}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="mx-auto mt-28 flex max-w-[1100px] flex-col items-center px-5 pb-24 text-center">
        <p className="text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">
          give your agent a heel
        </p>
        <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
          <CopyInstall command="npm install -g useheel" />
          <Link href="/docs" className={pill}>
            quick start
          </Link>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
