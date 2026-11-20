import { Check, EyeOff, Fingerprint, Pause, X } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * What else heel does, on the home page: one card per point, each with a small picture of it
 * (a rule, a passkey prompt, an inbox with rows hidden) above two lines of words.
 */

const chip = 'rounded px-1.5 py-px font-mono text-[10px] font-semibold';

function Rule() {
  return (
    <div className="flex h-full items-center">
      <pre className="font-mono text-[11px] leading-[1.6] text-neutral-500 dark:text-neutral-400">
        {'- match:\n    action: '}
        <span className="text-neutral-900 dark:text-white">email.send</span>
        {'\n    recipients:\n      all_domain_in: '}
        <span className="text-neutral-900 dark:text-white">[work.com]</span>
        {'\n  then: '}
        <span className={`${chip} bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300`}>allow</span>
      </pre>
    </div>
  );
}

function Passkey() {
  return (
    <div className="flex h-full flex-col justify-center gap-2 text-xs">
      <div className="flex items-center justify-between rounded-lg bg-neutral-900 px-3 py-2 text-white dark:bg-black">
        <span>Send an email?</span>
        <span className="flex items-center gap-1 rounded-md bg-white/10 px-2 py-1 text-[11px]">
          <Fingerprint className="size-3.5" /> you
        </span>
      </div>
      <div className="flex items-center justify-between rounded-lg border border-dashed border-black/15 px-3 py-2 text-neutral-500 dark:border-white/15">
        <span>your agent</span>
        <span className="flex items-center gap-1 text-[11px] text-red-600 dark:text-red-400">
          <X className="size-3.5" /> can't approve
        </span>
      </div>
    </div>
  );
}

function Inbox() {
  const rows: [string, string, boolean][] = [
    ['Alex', 'Friday plan', false],
    ['Bank', 'Reset your password', true],
    ['Acme', 'Your login code', true],
  ];
  return (
    <ul className="flex h-full flex-col justify-center gap-1.5 text-xs">
      {rows.map(([from, subject, hidden]) => (
        <li key={from} className="flex items-center gap-2 rounded-md bg-white px-2.5 py-1.5 dark:bg-white/5">
          <span className="w-10 shrink-0 font-medium">{from}</span>
          {hidden ? (
            <>
              <span className="h-2 flex-1 rounded-full bg-[repeating-linear-gradient(45deg,rgba(0,0,0,0.12)_0_4px,transparent_4px_8px)] dark:bg-[repeating-linear-gradient(45deg,rgba(255,255,255,0.15)_0_4px,transparent_4px_8px)]" />
              <span className="flex shrink-0 items-center gap-1 font-mono text-[10px] text-neutral-400">
                <EyeOff className="size-3" /> hidden
              </span>
            </>
          ) : (
            <span className="flex-1 truncate text-neutral-500">{subject}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function Switch() {
  return (
    <div className="flex h-full flex-col justify-center gap-2.5 text-xs">
      {['everything', 'gmail-work', 'my-agent'].map((what, i) => (
        <div key={what} className="flex items-center justify-between">
          <span className={i === 0 ? 'font-medium' : 'text-neutral-500'}>
            {i === 0 ? 'pause everything' : what}
          </span>
          <span
            className={`flex h-4 w-7 items-center rounded-full p-0.5 ${
              i === 0 ? 'justify-end bg-indigo-500' : 'bg-black/10 dark:bg-white/15'
            }`}
          >
            <span className="size-3 rounded-full bg-white shadow-sm" />
          </span>
        </div>
      ))}
      <span className="flex items-center gap-1.5 font-mono text-[10px] text-indigo-600 dark:text-indigo-300">
        <Pause className="size-3" /> nothing runs, even what you approved
      </span>
    </div>
  );
}

function Deciders() {
  return (
    <div className="flex h-full flex-wrap content-center items-center gap-1.5 text-xs">
      {['your rules', 'grants', 'you'].map((who) => (
        <span
          key={who}
          className="flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300"
        >
          <Check className="size-3" /> {who}
        </span>
      ))}
      <span className="flex items-center gap-1 rounded-full border border-dashed border-black/15 px-2.5 py-1 text-neutral-400 line-through dark:border-white/15">
        <X className="size-3" /> a model
      </span>
    </div>
  );
}

function Shell() {
  return (
    <div className="h-full rounded-lg bg-neutral-950 px-3 py-2.5 font-mono text-[11px] leading-[1.7] text-neutral-300">
      <div>
        <span className="text-neutral-500">$</span> heel start
      </div>
      <div className="text-emerald-400">● running on your machine</div>
      <div>
        <span className="text-neutral-500">keys:</span> heel's vault
      </div>
      <div>
        <span className="text-neutral-500">agent gets:</span> heel_… token
      </div>
    </div>
  );
}

const FEATURES: [ReactNode, string, string][] = [
  [
    <Rule key="rule" />,
    'rules on the arguments',
    'who an email goes to, which repo, whether ci passed, how many messages a run deleted. one yaml file for mcp, http and cli.',
  ],
  [
    <Passkey key="passkey" />,
    'approvals it can’t answer',
    'an ask waits for you. you see the full call and approve with a passkey, outside the agent’s session.',
  ],
  [
    <Inbox key="inbox" />,
    'hiding what it reads',
    'mail from people you name, password resets and login codes drop out before the agent sees them.',
  ],
  [
    <Switch key="switch" />,
    'one switch to stop it',
    'pause an agent, an account or everything, from your phone.',
  ],
  [
    <Deciders key="deciders" />,
    'no model decides a call',
    'whoever shapes a call could shape a model judging it. rules, grants and people decide.',
  ],
  [
    <Shell key="shell" />,
    'yours to run',
    'open source, self-hosted, one process. agents never hold your credentials.',
  ],
];

export function Features() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {FEATURES.map(([picture, title, body]) => (
        <div
          key={title}
          className="rounded-2xl border border-black/10 bg-white/70 p-2 shadow-[0_1px_2px_rgba(0,0,0,0.04)] dark:border-white/10 dark:bg-white/[0.03]"
        >
          <div
            aria-hidden
            className="h-[124px] overflow-hidden rounded-xl border border-black/[0.06] bg-neutral-50 p-3 dark:border-white/[0.06] dark:bg-white/[0.03]"
          >
            {picture}
          </div>
          <div className="px-3 pt-4 pb-3">
            <h3 className="font-medium">{title}</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">{body}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

