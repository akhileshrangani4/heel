import Link from 'next/link';
import { githubUrl, npmUrl } from '@/lib/shared';

const link = 'hover:text-neutral-900 dark:hover:text-white';

export function SiteFooter() {
  return (
    <footer className="border-t border-black/5 dark:border-white/10">
      <div className="mx-auto flex max-w-[1100px] flex-wrap items-center justify-between gap-4 px-5 py-7 text-sm text-neutral-500">
        <span>heel · apache 2.0</span>
        <span className="flex gap-5">
          <Link href="/docs" className={link}>
            docs
          </Link>
          <Link href="/roadmap" className={link}>
            roadmap
          </Link>
          <a href={githubUrl} className={link}>
            github
          </a>
          <a href={npmUrl} className={link}>
            npm
          </a>
        </span>
      </div>
    </footer>
  );
}
