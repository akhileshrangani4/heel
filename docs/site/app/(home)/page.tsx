import Link from 'next/link';
import { Fragment } from 'react';
import { CopyInstall } from '@/components/copy-install';
import { Features } from '@/components/features';
import { FlowDemo } from '@/components/flow-demo';
import { RulesDemo } from '@/components/rules-demo';
import { SectionSnap } from '@/components/section-snap';
import { SiteFooter } from '@/components/site-footer';

/** A dog sitting at heel. */
/**
 * heel's logo dog, written out in the word heel; it sits faint behind the wordmark. Its lower
 * body fades out, and what stays visible leans right, so it's shifted a little left to sit centred.
 */
const DOG = String.raw`                          :+heelheelh*-
                       .+eelheelheelheel+
                      +heelheelheelheelhee=.
                     lheelheelheelheelheelheelheelh-
                    eelheelheelheelheelheelheelheelh
                   =eelheelhe*elheelheelheelheelheel
                   heelheelhe**elheelheelheelheelhe=
                   elheelheelh:eelheelheelheelheel=
                  .heelheelhee:*lheelheelheelhe+-
                   elheelheelh.=eelheelhe+:
                   -elheelheel heelheelh
                    :*eelhee= +lheelhee.
                     *==--::=lheelheelh
                    +eelheelheelheelhee
                  :lheel**heelheelheelh.
                .*eelheelheelhe*******e:
              -lheelheelheelheelheelheel
           .+heelheelheelheelheelheelhee
         -lheelheelheelheelheelheelheelh:
       =eelheelheelheelheelheelheelheelh-
     -eelheelheelheelheelheelheelheelhee=
    lheelheelheelheelheelheelheelheelhee-
  :lheelheelheelheelheelheelheelheelheel:
 .heelheelheelheelheelheelheelheelheelhe
 elheelheelheelheelheelheelheelheelheelh
+eelheelheelheelheelheelheelheelheelhee*
lheelheelheelheelheelheelheelheelheelhe-
elheelheelheelheelheelheelheelheelheelh.
eelheelheelheelheelheelheelheelheelheel
heelheelheelheelheelheelheelheelheelhee*
:lheelheelheelheelheelheelheelheelheelhee*.
 =lheelheelheelheelheelheelheelheelheelheel-
  .*heelheelheelheelheelheelheelheelheelhee*
     -*lheelheelheelheelheelheelheelheelhe*`;

type Tone = 'allow' | 'deny' | 'ask' | 'paused' | 'ok';


const RULES = `# what this agent is for:
# catching up on your inbox and replying to people
rules:
  # reading email is allowed
  - match: { kind: read }
    then: allow

  # deleting over 20 emails is blocked
  - match:
      action: email.remove
      items: { over: 20, per: run }
    then: deny

  # sending email asks you
  - match: { action: email.send }
    then: ask

  # anything else is blocked: no rule matched`;

/** The quick start's commands, in order (docs/quickstart.md). */
const QUICKSTART: ['#' | '$', string][] = [
  ['#', '# 1 · install and set up'],
  ['$', 'npm install -g useheel'],
  ['$', 'heel init'],
  ['#', '# 2 · start it, and make your passkey'],
  ['$', 'heel start'],
  ['$', 'heel user enroll owner'],
  ['#', '# 3 · connect an account, then your agent'],
  ['$', 'gh auth token | heel connect github --as github --credential-stdin'],
  ['$', 'heel agent add my-agent'],
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

/** Each section below the hero fills one screen, its content centred in it. */
const screen =
  'relative mx-auto flex min-h-[calc(100svh-3.5rem)] max-w-[1100px] flex-col justify-center px-5 py-16';

function Window({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-black/10 bg-[#141414] text-[#e8e8e6] shadow-[0_24px_60px_-28px_rgba(0,0,0,0.45)] dark:border-white/10">
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-3">
        <span className="size-3 rounded-full bg-[#ff5f57]" />
        <span className="size-3 rounded-full bg-[#febc2e]" />
        <span className="size-3 rounded-full bg-[#28c840]" />
        <span className="ml-3 truncate font-mono text-xs text-white/40">{title}</span>
      </div>
      {children}
    </div>
  );
}

function Sticker({ label, className }: { label: string; className: string }) {
  return (
    <span
      aria-hidden
      className={`pointer-events-none absolute hidden rounded-md border px-2.5 py-1 font-mono text-xs font-medium shadow-sm lg:block short:hidden ${className}`}
    >
      {label}
    </span>
  );
}

export default function HomePage() {
  return (
    <main className="relative flex-1 overflow-x-clip">
      <section data-snap className="relative isolate mx-auto flex min-h-[calc(100svh-3.5rem)] max-w-[1100px] flex-col items-center justify-center px-5 py-10 text-center short:py-3">
        {/* pinned to the background's dot grid (rows every 22px, the first 11px down): the dog's
            top touches the second row, the stickers sit on rows below it */}
        <Sticker
          label="allow"
          className="top-[165px] left-[9%] -rotate-6 border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
        />
        <Sticker
          label="deny"
          className="top-[231px] right-[8%] rotate-[8deg] border-red-300 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
        />
        <Sticker
          label="ask"
          className="top-[297px] left-[15%] rotate-[4deg] border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300"
        />

        {/* the dog, big and faint behind the wordmark */}
        <pre
          aria-hidden
          className="pointer-events-none absolute top-[calc(33px-0.1em)] left-1/2 -z-10 -translate-x-[calc(50%+2.6ch-2px)] select-none [mask-image:linear-gradient(to_bottom,black_55%,transparent_88%)] text-left font-mono text-[9px] leading-none text-neutral-900/[0.07] sm:text-[13px] short:text-[11px] dark:text-white/[0.07]"
        >
          {DOG}
        </pre>
        <div className="relative flex w-full flex-col items-center">
          <h1
            className="rise text-[clamp(4rem,13vw,6.5rem)] leading-none short:text-[5rem] font-semibold tracking-[-0.06em]"
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
            className="rise mt-6 flex flex-wrap items-center justify-center gap-3"
            style={{ animationDelay: '180ms' }}
          >
            <CopyInstall
              label="copy prompt"
              command="Set up heel for me: run curl -fsSL https://useheel.dev/setup.md and follow it"
            />
            <Link href="/docs" className={pill}>
              read the docs
            </Link>
          </div>
          <p className="rise mt-3 text-xs text-neutral-400 short:hidden" style={{ animationDelay: '220ms' }}>
            paste it into your agent · open source · self-hosted
          </p>

          <div className="rise mt-8 w-full max-w-[960px] short:mt-6" style={{ animationDelay: '280ms' }}>
            <FlowDemo />
          </div>
        </div>
      </section>

      <section data-snap className={screen}>
        <div className="grid grid-cols-[minmax(0,1fr)] items-center gap-10 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] md:gap-14">
        <div className="relative">
          <h2 className="text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">
            say what the agent is for
          </h2>
          <p className="mt-4 max-w-md leading-relaxed text-neutral-600 dark:text-neutral-300">
            rules are a file you can read, review and test. the first match decides, and a call no
            rule matches is denied. these are the rules behind the flow above.
          </p>
          <div className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-sm font-medium">
            <Link
              href="/docs/quickstart"
              className="underline decoration-neutral-300 underline-offset-4 hover:decoration-current dark:decoration-neutral-600"
            >
              get started in 10 minutes →
            </Link>
          </div>
        </div>
        <div className="relative min-w-0 md:min-h-[504px]">
          <RulesDemo
            yaml={
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
            }
          />
        </div>
        </div>
      </section>

      <section data-snap className={screen}>
        <div className="relative">
          <h2 className="mb-8 text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">what else it does</h2>
          <Features />
        </div>
      </section>

      {/* the last screen: the closing section, with the footer at its foot */}
      <div data-snap className="flex min-h-[calc(100svh-3.5rem)] flex-col">
        <section className="relative mx-auto flex w-full max-w-[1100px] flex-1 flex-col items-center justify-center px-5 py-10 text-center">
          <div className="relative flex w-full flex-col items-center">
            <h2 className="text-[clamp(2.5rem,7vw,4.5rem)] leading-none font-semibold tracking-[-0.05em] text-balance">
              give your agent a heel
            </h2>
            <p className="mt-4 text-lg text-balance text-neutral-600 sm:text-xl dark:text-neutral-300">
              tell your agent one line. it sets heel up; you approve with a passkey.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <CopyInstall
                label="copy prompt"
                command="Set up heel for me: run curl -fsSL https://useheel.dev/setup.md and follow it"
              />
              <Link href="/docs/quickstart" className={pill}>
                how it works
              </Link>
            </div>
            <div className="mt-10 w-full max-w-2xl text-left">
              <Window title="or by hand: the quick start">
                <pre className="overflow-x-auto px-4 py-4 font-mono text-[12px] leading-[1.7] whitespace-pre-wrap sm:px-6 sm:py-5 sm:text-[12.5px] sm:leading-[1.8] sm:whitespace-pre">
                  {QUICKSTART.map(([kind, line]) => (
                    <span key={line} className={`block pl-[2ch] -indent-[2ch] sm:pl-0 sm:indent-0 ${kind === '#' ? 'mt-2 text-white/35 first:mt-0' : ''}`}>
                      {kind === '$' ? <span className="text-white/35">$ </span> : null}
                      {/* on a phone a long command wraps between words, never inside a flag */}
                      {line.split(' ').map((word, i) => (
                        <Fragment key={i}>
                          {i > 0 ? ' ' : null}
                          <span className="whitespace-nowrap">{word}</span>
                        </Fragment>
                      ))}
                    </span>
                  ))}
                </pre>
              </Window>
            </div>
            <div className="mt-8 flex flex-col items-center gap-3">
              <p className="text-sm text-neutral-500 dark:text-neutral-400">teach any agent how to work through heel</p>
              <CopyInstall quiet command="npx skills add akhileshrangani4/heel" />
            </div>
          </div>
        </section>
        <SiteFooter />
      </div>
      <SectionSnap />
    </main>
  );
}
