'use client';

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

/**
 * A pill that copies a line. A shell command shows itself with a `$`; with
 * a `label`, the pill shows that instead (a long prompt for an agent).
 * `quiet` is the outlined look, for a line that sits below the main one.
 */
export function CopyInstall({ command, label, quiet }: { command: string; label?: string; quiet?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(command);
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      }}
      className={`group flex max-w-full cursor-pointer items-center gap-3 rounded-full py-2.5 pr-4 pl-5 font-mono text-sm transition-colors ${
        quiet
          ? 'border border-black/10 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.06)] hover:bg-neutral-50 dark:border-white/15 dark:bg-white/5 dark:hover:bg-white/10'
          : 'bg-neutral-900 text-white shadow-[0_1px_2px_rgba(0,0,0,0.2)] hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200'
      }`}
      aria-label={`Copy: ${command}`}
    >
      <span className="min-w-0 truncate">
        {label ?? (
          <>
            <span className={`select-none ${quiet ? 'text-black/35 dark:text-white/40' : 'text-white/45 dark:text-black/40'}`}>$ </span>
            {command}
          </>
        )}
      </span>
      {copied ? (
        <Check className="size-4 shrink-0 text-emerald-400 dark:text-emerald-600" />
      ) : (
        <Copy className="size-4 shrink-0 opacity-50 transition-opacity group-hover:opacity-90" />
      )}
    </button>
  );
}
