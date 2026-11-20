'use client';

import { Bot, Check, Fingerprint, Mail, ShieldX, Smartphone } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

/**
 * How a call moves through heel, as a small animation for the home page:
 * the agent asks, heel checks the rules, the owner decides on their phone
 * when a rule asks, and the call runs (or doesn't). Not heel's real UI; a
 * sketch of the flow. Three scenarios cycle, and the tabs pick one.
 * Respects reduced motion: the final frame of the chosen scenario, no timer.
 */

type Verdict = 'allow' | 'deny' | 'ask';
type Step = 'call' | 'travel' | 'check' | 'phone' | 'passkey' | 'run' | 'bounce' | 'done';

interface Scenario {
  verdict: Verdict;
  tab: string;
  /** What the agent asks, as heel names it. */
  call: string;
  detail: string;
  /** How the call sits with what you asked for. */
  fits: string;
  /** The rule that decides, in words. */
  rule: string;
  /** What the account shows once it ran. */
  result: string;
  steps: [Step, number][];
}

/** What you asked the agent to do: heel holds every call to it. */
const INTENT = 'Catch me up on my inbox and reply to Alex about Friday.';

/** Three calls the agent makes for that one task, in the order it makes them. */
const SCENARIOS: Scenario[] = [
  {
    verdict: 'allow',
    tab: '1 · read',
    call: 'read the inbox',
    detail: 'newest 12 emails',
    fits: 'fits what you asked',
    rule: 'reading email',
    result: 'read 12 emails',
    steps: [
      ['call', 1100],
      ['travel', 900],
      ['check', 1400],
      ['run', 900],
      ['done', 2400],
    ],
  },
  {
    verdict: 'ask',
    tab: '2 · reply',
    call: 'send an email',
    detail: 'to alex@work.com',
    fits: 'fits what you asked',
    rule: 'sending email',
    result: 'reply sent',
    steps: [
      ['call', 1100],
      ['travel', 900],
      ['check', 1400],
      ['phone', 1500],
      ['passkey', 1400],
      ['run', 900],
      ['done', 2400],
    ],
  },
  {
    verdict: 'deny',
    tab: '3 · delete',
    call: 'delete 500 emails',
    detail: 'everything older than a week',
    fits: "not what you asked",
    rule: 'deleting over 20 emails',
    result: 'nothing deleted',
    steps: [
      ['call', 1100],
      ['travel', 900],
      ['check', 1500],
      ['bounce', 900],
      ['done', 2600],
    ],
  },
];

const ORDER: Step[] = ['call', 'travel', 'check', 'phone', 'passkey', 'run', 'bounce', 'done'];
const reached = (now: Step, at: Step) => ORDER.indexOf(now) >= ORDER.indexOf(at);

const VERDICT_STYLE: Record<Verdict, string> = {
  allow:
    'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  deny: 'border-red-300 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300',
  ask: 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300',
};
const VERDICT_WORD: Record<Verdict, string> = { allow: 'allowed', deny: 'blocked', ask: 'asks you' };

// z-10: a travelling dot passes under the cards, never over their edges.
const card =
  'relative z-10 rounded-xl border border-black/10 bg-white p-4 text-left shadow-[0_1px_2px_rgba(0,0,0,0.05)] transition-[opacity,transform,border-color,box-shadow] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] dark:border-white/10 dark:bg-neutral-900';

/** A dashed line between two cards; the call travels along it while `moving`. */
function Wire({
  label,
  moving,
  back,
  tone,
  vertical = false,
}: {
  label: string;
  moving: boolean;
  back: boolean;
  tone: 'neutral' | 'red' | 'green';
  vertical?: boolean;
}) {
  const color =
    tone === 'red'
      ? 'bg-red-500 ring-red-500/20'
      : tone === 'green'
        ? 'bg-emerald-500 ring-emerald-500/20'
        : 'bg-neutral-900 ring-neutral-900/15 dark:bg-white dark:ring-white/20';
  return (
    <div aria-hidden className={`relative z-0 ${vertical ? 'mx-auto h-10 w-px' : 'h-px w-full'}`}>
      <div
        className={`absolute inset-0 border-dashed border-black/20 dark:border-white/25 ${
          vertical ? 'border-l' : 'border-t'
        }`}
      />
      {moving ? (
        // A track as long as the wire, moved with transform (composited, no layout per
        // frame); the pill sits at the track's start, centred on it.
        <span
          key={`${label}-${back}`}
          className={`absolute inset-0 ${vertical ? 'heel-travel-y' : 'heel-travel-x'}`}
          style={{ animationDirection: back ? 'reverse' : 'normal' }}
        >
          <span
            title={label}
            className={`absolute size-2.5 rounded-full ring-4 ${color} ${
              vertical
                ? 'top-0 left-1/2 -translate-x-1/2 -translate-y-1/2'
                : 'top-1/2 left-0 -translate-x-1/2 -translate-y-1/2'
            }`}
          />
        </span>
      ) : null}
    </div>
  );
}

export function FlowDemo() {
  const [index, setIndex] = useState(0);
  const [stepIndex, setStepIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(query.matches);
    const change = () => setReduced(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);

  const scenario = SCENARIOS[index] ?? SCENARIOS[0];
  const steps = scenario?.steps ?? [];
  const step: Step = reduced ? 'done' : (steps[stepIndex]?.[0] ?? 'done');

  useEffect(() => {
    if (reduced || paused) return;
    const duration = steps[stepIndex]?.[1] ?? 2000;
    timer.current = setTimeout(() => {
      if (stepIndex + 1 < steps.length) setStepIndex(stepIndex + 1);
      else {
        setIndex((index + 1) % SCENARIOS.length);
        setStepIndex(0);
      }
    }, duration);
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [index, stepIndex, steps, reduced, paused]);

  if (scenario === undefined) return null;
  const { verdict } = scenario;
  const checked = reached(step, 'check');
  const asks = verdict === 'ask';
  const phoneOn = asks && reached(step, 'phone');
  const approved = asks && reached(step, 'passkey');
  const ran = verdict !== 'deny' && reached(step, 'run');
  const done = step === 'done';
  const bounced = verdict === 'deny' && reached(step, 'bounce');

  const stages: [string, boolean, boolean][] = [
    ['your agent asks', true, reached(step, 'travel')],
    ['heel checks', reached(step, 'travel'), checked],
    ['you approve', asks && reached(step, 'check'), approved],
    [verdict === 'deny' ? 'blocked' : 'done', ran || bounced, done],
  ];

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover only pauses the animation.
    <div
      className="w-full"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      {/* intent and the step tabs share a row on wide screens, to keep the hero on one screen */}
      <div className="mb-4 flex flex-col items-center justify-center gap-3 md:flex-row md:gap-8">
        <div className="flex max-w-xl items-start gap-3 text-left">
          <span className="mt-0.5 shrink-0 rounded-md border border-black/10 bg-white px-2 py-0.5 font-mono text-[11px] text-neutral-500 dark:border-white/15 dark:bg-white/5">
            your intent
          </span>
          <p className="text-sm leading-relaxed sm:text-base">“{INTENT}”</p>
        </div>
        <div role="tablist" aria-label="what heel does with a call" className="flex shrink-0 justify-center gap-2">
          {SCENARIOS.map((s, i) => (
            <button
              key={s.verdict}
              type="button"
              role="tab"
              aria-selected={i === index}
              onClick={() => {
                setIndex(i);
                setStepIndex(0);
              }}
              className={`rounded-md border px-2.5 py-1 font-mono text-xs font-medium transition-colors ${
                i === index
                  ? VERDICT_STYLE[s.verdict]
                  : 'border-black/10 bg-white/70 text-neutral-500 hover:text-neutral-900 dark:border-white/10 dark:bg-white/5 dark:hover:text-white'
              }`}
            >
              {s.tab}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-2xl border border-black/10 bg-white/60 p-4 shadow-[0_24px_60px_-32px_rgba(0,0,0,0.35)] sm:p-5 dark:border-white/10 dark:bg-white/[0.03]">
        <div className="grid grid-cols-1 items-start gap-y-3 md:grid-cols-[minmax(0,1fr)_104px_minmax(0,1.1fr)_104px_minmax(0,1fr)] md:gap-y-0">
          {/* the agent */}
          <div className={card}>
            <div className="flex items-center gap-2 text-sm font-medium">
              <span className="grid size-7 place-items-center rounded-lg bg-neutral-100 dark:bg-white/10">
                <Bot className="size-4" />
              </span>
              your agent
            </div>
            <div className="mt-3 rounded-lg bg-neutral-50 px-3 py-2 text-xs dark:bg-white/5">
              <div className="text-[10px] text-neutral-400">wants to</div>
              <div className="font-medium">{scenario.call}</div>
              <div className="mt-0.5 truncate text-neutral-500">{scenario.detail}</div>
            </div>
            <div
              className={`mt-2 flex items-center gap-1.5 text-xs transition-opacity duration-300 ${
                bounced ? 'text-red-600 opacity-100 dark:text-red-400' : 'opacity-0'
              }`}
            >
              <ShieldX className="size-3.5" /> blocked by heel
            </div>
          </div>

          <div className="md:hidden">
            <Wire
              label={scenario.call}
              moving={step === 'travel' || step === 'bounce'}
              back={step === 'bounce'}
              tone={step === 'bounce' ? 'red' : 'neutral'}
              vertical
            />
          </div>
          <div className="hidden md:block md:self-start md:pt-[60px]">
            <Wire label={scenario.call} moving={step === 'travel' || step === 'bounce'} back={step === 'bounce'} tone={step === 'bounce' ? 'red' : 'neutral'} />
          </div>

          {/* heel */}
          <div className="flex flex-col">
            <div className={`${card} ${checked ? 'shadow-[0_12px_30px_-18px_rgba(0,0,0,0.45)]' : ''}`}>
              <div className="flex items-center gap-2 text-sm font-medium">
                {/* biome-ignore lint/performance/noImgElement: a static SVG logo */}
                <img src="/heel-icon.svg" alt="" width={28} height={28} className="rounded-lg" />
                heel
                <span className="ml-auto font-mono text-[10px] text-neutral-400">
                  {step === 'travel' ? 'checking…' : ''}
                </span>
              </div>
              <div
                className={`mt-3 flex items-center gap-1.5 text-[11px] transition-opacity duration-500 ${
                  checked ? 'opacity-100' : 'opacity-0'
                } ${verdict === 'deny' ? 'text-red-600 dark:text-red-400' : 'text-emerald-700 dark:text-emerald-400'}`}
              >
                {verdict === 'deny' ? <ShieldX className="size-3.5" /> : <Check className="size-3.5" />}
                {scenario.fits}
              </div>
              <div
                className={`mt-1.5 flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs transition-all duration-500 ${
                  checked ? VERDICT_STYLE[verdict] : 'border-dashed border-black/10 text-neutral-400 dark:border-white/15'
                }`}
              >
                <span className="whitespace-nowrap">{checked ? scenario.rule : 'your rules'}</span>
                <span className="shrink-0 font-semibold">{checked ? VERDICT_WORD[verdict] : '…'}</span>
              </div>
            </div>

            {/* the phone: it buzzes only when a rule asks */}
            {/* Holds the phone's full height either way, so nothing below jumps when it buzzes. */}
            <div aria-hidden={!phoneOn} className="min-h-[162px]">
              <div aria-hidden className="mx-auto h-6 w-px border-l border-dashed border-black/15 dark:border-white/20" />
              <div
                className={`relative z-10 mx-auto w-[220px] rounded-[22px] border p-2 transition-all duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                  phoneOn
                    ? 'border-black/15 bg-neutral-950 shadow-lg dark:border-white/15'
                    : 'border-dashed border-black/15 bg-transparent dark:border-white/15'
                }`}
              >
                {phoneOn ? (
                  <div className="rounded-[16px] bg-neutral-900 p-3 text-white">
                    <div className="flex items-center gap-1.5 text-[10px] text-white/50">
                      <Smartphone className="size-3" /> heel · now
                    </div>
                    <div className="mt-1 text-xs font-medium">Send an email?</div>
                    <div className="text-[11px] text-white/60">to alex@work.com</div>
                    <div
                      className={`mt-3 flex h-8 items-center justify-center gap-2 whitespace-nowrap rounded-lg px-2 text-xs font-medium transition-colors duration-500 ${
                        approved ? 'bg-emerald-500 text-white' : 'bg-white/10 text-white/80'
                      }`}
                    >
                      {approved ? (
                        <>
                          <Check className="size-3.5 shrink-0" /> approved
                        </>
                      ) : (
                        <>
                          <Fingerprint className={`size-4 ${step === 'phone' ? 'animate-pulse' : ''}`} /> approve
                        </>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 rounded-[16px] px-3 py-3 text-[11px] text-neutral-400">
                    <Smartphone className="size-3.5 shrink-0" />
                    {asks ? 'your phone' : 'your phone stays quiet'}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="md:hidden">
            <Wire label={scenario.call} moving={step === 'run'} back={false} tone="green" vertical />
          </div>
          <div className="hidden md:block md:self-start md:pt-[60px]">
            <Wire label={scenario.call} moving={step === 'run'} back={false} tone="green" />
          </div>

          {/* the account */}
          <div className={`${card} ${verdict === 'deny' && checked ? 'opacity-50' : ''}`}>
            <div className="flex items-center gap-2 text-sm font-medium">
              <span className="grid size-7 place-items-center rounded-lg bg-neutral-100 dark:bg-white/10">
                <Mail className="size-4" />
              </span>
              Gmail
            </div>
            <div className="mt-3 flex items-center gap-1.5 rounded-lg bg-neutral-50 px-3 py-2 text-xs dark:bg-white/5">
              {done || (ran && step !== 'run') ? (
                verdict === 'deny' ? (
                  <span className="text-neutral-500">untouched</span>
                ) : (
                  <span className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
                    <Check className="size-3.5" /> {scenario.result}
                  </span>
                )
              ) : (
                <span className="text-neutral-400">{verdict === 'deny' && checked ? 'untouched' : 'waiting'}</span>
              )}
            </div>
            <p className="mt-2 text-[11px] text-neutral-400">heel holds the login; your agent never sees it.</p>
          </div>
        </div>

        {/* where we are */}
        <ol className="mt-4 grid grid-cols-4 gap-2" aria-label="steps">
          {stages.map(([label, on, full]) => (
            <li key={label} className={`transition-opacity duration-300 ${on ? 'opacity-100' : 'opacity-40'}`}>
              <div className="h-1 overflow-hidden rounded-full bg-black/[0.07] dark:bg-white/10">
                <div
                  className={`h-full w-full origin-left rounded-full transition-transform duration-700 ease-out ${
                    label === 'blocked' ? 'bg-red-500' : label === 'you approve' ? 'bg-amber-500' : 'bg-emerald-500'
                  }`}
                  // scaleX, not width: a transform animates on the GPU, with no layout per frame
                  style={{ transform: `scaleX(${full ? 1 : on ? 0.45 : 0})` }}
                />
              </div>
              <span className="mt-1.5 block text-center font-mono text-[10px] text-neutral-500 sm:text-[11px]">
                {label}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
