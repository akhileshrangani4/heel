'use client';

import { useEffect, useState } from 'react';

/**
 * First match decides, as an animation for the home page: a call steps down
 * the rules until one matches, and a call no rule matches is denied. The
 * same rules as the YAML file shown under "yaml", in words. Respects
 * reduced motion: each call's result, no stepping.
 */

type Verdict = 'allow' | 'deny' | 'ask';

/** What this agent is for, as you'd say it; the rules below are how heel holds it to that. */
const INTENT = 'catching up on your inbox and replying to people';

const RULES: [string, Verdict][] = [
  ['reading email', 'allow'],
  ['deleting over 20 emails', 'deny'],
  ['sending email', 'ask'],
];

/** Example calls and the index of the rule that decides each; -1 for none. */
const CALLS: [string, number][] = [
  ['read the inbox', 0],
  ['send an email to alex@work.com', 2],
  ['delete 500 emails', 1],
  ['forward all new email to another address', -1],
];

const STYLE: Record<Verdict, string> = {
  allow:
    'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  deny: 'border-red-300 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300',
  ask: 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300',
};
const WORD: Record<Verdict, string> = { allow: 'allowed', deny: 'blocked', ask: 'asks you' };

const STEP_MS = 450;
const HOLD_MS = 2200;

export function RulesDemo({ yaml }: { yaml: React.ReactNode }) {
  const [view, setView] = useState<'words' | 'yaml'>('words');
  const [call, setCall] = useState(0);
  /** Which rule the call is at; RULES.length means it fell past the last one. */
  const [at, setAt] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(query.matches);
  }, []);

  const [label, target] = CALLS[call] ?? CALLS[0] ?? ['', -1];
  const stop = target === -1 ? RULES.length : target;
  const position = reduced ? stop : at;
  const settled = position === stop;

  useEffect(() => {
    if (reduced || paused || view !== 'words') return;
    const timer = setTimeout(
      () => {
        if (!settled) setAt(at + 1);
        else {
          setCall((call + 1) % CALLS.length);
          setAt(0);
        }
      },
      settled ? HOLD_MS : STEP_MS,
    );
    return () => clearTimeout(timer);
  }, [at, call, settled, reduced, paused, view]);

  const verdict: Verdict = target === -1 ? 'deny' : (RULES[target]?.[1] ?? 'deny');

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover only pauses the animation.
    <div onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div role="tablist" aria-label="how to show the rules" className="flex gap-1.5">
          {(['words', 'yaml'] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              onClick={() => setView(v)}
              className={`whitespace-nowrap rounded-md border px-2.5 py-1 font-mono text-xs transition-colors ${
                view === v
                  ? 'border-black/20 bg-white text-neutral-900 dark:border-white/25 dark:bg-white/10 dark:text-white'
                  : 'border-transparent text-neutral-500 hover:text-neutral-900 dark:hover:text-white'
              }`}
            >
              {v === 'words' ? 'in words' : 'rules/owner.yaml'}
            </button>
          ))}
        </div>
        {view === 'words' ? (
          <span className="hidden font-mono text-[11px] text-neutral-400 sm:inline">first match decides</span>
        ) : null}
      </div>

      {view === 'yaml' ? (
        yaml
      ) : (
        <div className="rounded-2xl border border-black/10 bg-white/60 p-4 shadow-[0_24px_60px_-32px_rgba(0,0,0,0.35)] sm:p-5 dark:border-white/10 dark:bg-white/[0.03]">
          <p className="mb-4 border-b border-black/[0.06] pb-3 text-sm dark:border-white/[0.08]">
            <span className="font-mono text-[11px] text-neutral-400">what this agent is for: </span>
            {INTENT}
          </p>
          <div className="flex items-center gap-2">
            <span className="shrink-0 font-mono text-[11px] text-neutral-400">it wants to</span>
            <span
              key={label}
              className="rise truncate rounded-full bg-neutral-900 px-3 py-1 font-mono text-xs text-white dark:bg-white dark:text-neutral-900"
            >
              {label}
            </span>
          </div>

          <ol className="mt-4 space-y-2">
            {RULES.map(([rule, decision], i) => {
              const here = position === i;
              const passed = position > i;
              const decided = settled && here;
              return (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: static rules, in order
                  key={i}
                  className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 text-sm transition-all duration-300 ${
                    decided
                      ? `${STYLE[decision]} scale-[1.01] shadow-sm`
                      : here
                        ? 'border-black/25 bg-white dark:border-white/30 dark:bg-white/10'
                        : 'border-black/10 bg-white/70 dark:border-white/10 dark:bg-white/[0.03]'
                  } ${passed ? 'opacity-45' : ''}`}
                >
                  <span className="w-4 font-mono text-[11px] text-neutral-400">{i + 1}</span>
                  <span className="flex-1">{rule}</span>
                  <span className="font-mono text-[11px]">
                    {passed ? (
                      <span className="text-neutral-400">no match</span>
                    ) : decided ? (
                      <span className="font-semibold">{WORD[decision]}</span>
                    ) : (
                      <span className="text-neutral-400">{WORD[decision]}</span>
                    )}
                  </span>
                </li>
              );
            })}
            <li
              className={`flex items-center gap-3 rounded-xl border border-dashed px-3 py-2.5 text-sm transition-all duration-300 ${
                position === RULES.length
                  ? `${STYLE.deny} border-solid`
                  : 'border-black/15 text-neutral-400 dark:border-white/15'
              }`}
            >
              <span className="w-4" />
              <span className="flex-1">anything else</span>
              <span className="font-mono text-[11px] font-semibold">blocked</span>
            </li>
          </ol>

          <p
            className={`mt-4 font-mono text-xs transition-opacity duration-300 ${settled ? 'opacity-100' : 'opacity-0'}`}
          >
            → {WORD[verdict]}
            <span className="text-neutral-400">
              {target === -1 ? ' · no rule allows it' : ` · rule ${target + 1} decides`}
            </span>
          </p>
        </div>
      )}
    </div>
  );
}
