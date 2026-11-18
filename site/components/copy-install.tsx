'use client';

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

/** The install command as a pill that copies itself. */
export function CopyInstall({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(command);
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      }}
      className="group flex items-center gap-3 rounded-full bg-neutral-900 py-2.5 pr-4 pl-5 font-mono text-sm text-white shadow-[0_1px_2px_rgba(0,0,0,0.2)] transition-colors hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
      aria-label={`Copy: ${command}`}
    >
      <span>
        <span className="text-white/45 select-none dark:text-black/40">$ </span>
        {command}
      </span>
      {copied ? (
        <Check className="size-4 text-emerald-400 dark:text-emerald-600" />
      ) : (
        <Copy className="size-4 opacity-50 transition-opacity group-hover:opacity-90" />
      )}
    </button>
  );
}
